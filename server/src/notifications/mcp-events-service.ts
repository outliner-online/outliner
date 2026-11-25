import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import type Database from "better-sqlite3";
import type { VerifiedOAuthAccessToken } from "../oauth/types.js";
import { CredentialEnvelope } from "./credential-envelope.js";
import { sendNotificationHttps } from "./https-transport.js";
import {
    buildChangedEvent,
    callbackIdentity,
    changedEvent,
    listEventsParams,
    subscribeEventsParams,
    unsubscribeEventsParams,
} from "./mcp-events-protocol.js";
import { EventsError, McpLeaseStore } from "./mcp-lease-store.js";
import { createMcpCallbackVerifier, signMcpWebhook } from "./mcp-webhook.js";
import type { NotificationObservationRuntime } from "./observation-runtime.js";
import type { PreparedViewChange, ViewChangeAttemptOutcome } from "./prepared-view-change.js";

export class NotificationEventsService {
    private readonly abort = new AbortController();
    private readonly latest = new Map<string, ViewChangeAttemptOutcome["outcome"]>();
    private readonly operations = new Set<Promise<unknown>>();
    private detach?: () => void;
    private timer?: NodeJS.Timeout;
    private closed = false;
    constructor(
        private readonly store: McpLeaseStore | undefined,
        private readonly runtime: NotificationObservationRuntime,
        private readonly sender = sendNotificationHttps,
    ) {
        if (store) {
            this.detach = runtime.subscribe("mcp", prepared => {
                const operation = this.deliver(prepared);
                this.operations.add(operation);
                void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
                return operation;
            });
        }
        this.schedule();
    }
    static create(
        database: () => Database.Database | undefined,
        key: string | undefined,
        runtime: NotificationObservationRuntime,
    ) {
        let store: McpLeaseStore | undefined;
        try {
            if (key) store = new McpLeaseStore(database, new CredentialEnvelope(key));
        } catch { /* fail closed */ }
        return new NotificationEventsService(store, runtime);
    }
    ready(): boolean {
        return !this.closed && !this.runtime.isClosed() && !!this.detach && !!this.store?.ready();
    }
    private requireStore(): McpLeaseStore {
        if (!this.ready()) throw new EventsError("unavailable");
        return this.store!;
    }
    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.closed) return;
        try {
            const deadline = this.store?.sweep();
            if (deadline !== undefined) {
                this.timer = setTimeout(() => this.schedule(),
                    Math.min(2_147_483_647, Math.max(1, deadline - Date.now()))).unref();
            }
        } catch { /* status and registration fail unavailable */ }
    }
    status(uid: string) {
        try {
            return { ...this.requireStore().status(uid), latestAttempt: this.latest.get(uid) ?? null };
        } catch {
            return { state: "unavailable", latestAttempt: this.latest.get(uid) ?? null };
        }
    }
    register(mcp: McpServer, actor: Partial<VerifiedOAuthAccessToken>): void {
        const call = async <T>(action: () => Promise<T> | T) => {
            try {
                this.requireStore();
                if (
                    !actor.uid || !actor.clientId || !actor.scope?.split(/\s+/).includes("outliner.read")
                    || !Number.isSafeInteger(actor.expiresAtMs) || actor.expiresAtMs! <= Date.now()
                ) throw new EventsError("expired");
                return await action();
            } catch (error) {
                const category = error instanceof EventsError ? error.category : "unavailable";
                throw new ProtocolError(-32000, `Notification Events ${category}`, { code: category });
            }
        };
        mcp.server.setRequestHandler("events/list", { params: listEventsParams },
            () => call(() => ({ events: [changedEvent] })));
        mcp.server.setRequestHandler("events/subscribe", { params: subscribeEventsParams }, params => call(async () => {
            const store = this.requireStore();
            const candidate = store.reserve({
                uid: actor.uid!,
                clientId: actor.clientId!,
                identity: callbackIdentity(actor.clientId!, params.delivery.url),
                expiresAtMs: Math.min(actor.expiresAtMs!, Date.now() + (params.ttlMs ?? 3_600_000)),
                callbackUrl: params.delivery.url,
                signingSecret: params.delivery.secret,
            });
            this.schedule();
            try {
                const current = () => !this.closed && store.candidateCurrent(candidate);
                const result = await createMcpCallbackVerifier(this.sender)({
                    url: candidate.lease.callbackUrl,
                    secret: candidate.lease.signingSecret,
                    subscriptionId: candidate.lease.subscriptionId,
                    authorizationDeadlineMs: candidate.deadline,
                    signal: this.abort.signal,
                    canStart: current,
                    revalidate: async () => current() ? { isCurrent: current } : null,
                });
                if (result.kind !== "verified") throw new EventsError("verification_failed");
                if (this.closed) throw new EventsError("unavailable");
                const lease = store.commit(candidate);
                return {
                    id: lease.subscriptionId,
                    refreshBefore: new Date(lease.expiresAtMs).toISOString(),
                    cursor: null,
                    truncated: false,
                };
            } finally {
                store.fail(candidate);
                this.schedule();
            }
        }));
        mcp.server.setRequestHandler("events/unsubscribe", { params: unsubscribeEventsParams }, params => call(() => {
            this.requireStore().remove(actor.uid!, callbackIdentity(actor.clientId!, params.delivery.url));
            this.schedule();
            return {};
        }));
    }
    async deliver(prepared: PreparedViewChange): Promise<void> {
        let settlement: ViewChangeAttemptOutcome = { initiated: false, outcome: "failed" };
        try {
            const store = this.requireStore();
            const lease = store.capture(prepared.uid);
            if (!lease) {
                settlement = { initiated: false, outcome: "no_destination" };
                return;
            }
            let refusal: "cancelled" | "deferred" | "no_destination" | undefined;
            const leaseCurrent = () => !this.closed && store.isCurrent(lease);
            const outcome = await this.sender({
                url: lease.callbackUrl,
                headerProfile: "mcp-events",
                responseMode: "status",
                authorizationDeadlineMs: lease.expiresAtMs,
                canStart: leaseCurrent,
                signal: this.abort.signal,
                beforeSend: async () => {
                    const validation = await prepared.revalidate();
                    if (validation.status !== "current") {
                        refusal = validation.status;
                        return null;
                    }
                    if (!leaseCurrent()) {
                        // A destination change drops this opportunity; do not replay it on the new lease.
                        refusal = "no_destination";
                        return null;
                    }
                    const signed = signMcpWebhook({
                        body: buildChangedEvent(prepared, Date.now()),
                        eventId: prepared.eventId,
                        subscriptionId: lease.subscriptionId,
                        secret: lease.signingSecret,
                        timestampMs: Date.now(),
                    });
                    return {
                        ...signed,
                        isCurrent: () => {
                            if (!validation.candidate.isCurrent()) {
                                refusal = "deferred";
                                return false;
                            }
                            if (!leaseCurrent()) {
                                refusal = "no_destination";
                                return false;
                            }
                            return true;
                        },
                    };
                },
            });
            settlement = {
                initiated: outcome.writeInitiated,
                outcome: outcome.kind === "accepted"
                    ? "accepted"
                    : outcome.writeInitiated
                            && (outcome.kind === "unknown" || (outcome.kind === "rejected" && outcome.reason === "tls"))
                    ? "unknown"
                    : refusal ?? (Date.now() >= lease.expiresAtMs ? "expired" : "failed"),
            };
            if (outcome.kind === "http_error" && outcome.status === 410) {
                try {
                    store.gone(lease);
                } catch { /* preserve transport evidence even if storage has closed */ }
            }
        } catch {
            /* local/pre-write failure, with no credential details */
        } finally {
            // Process-local bounded evidence, never a history or an event queue.
            if (this.latest.size >= 1024 && !this.latest.has(prepared.uid)) {
                this.latest.delete(this.latest.keys().next().value!);
            }
            this.latest.set(prepared.uid, settlement.outcome);
            prepared.settleAttempt(settlement);
            this.schedule();
        }
    }
    async close(): Promise<void> {
        this.closed = true;
        this.detach?.();
        this.detach = undefined;
        if (this.timer) clearTimeout(this.timer);
        this.abort.abort();
        await Promise.allSettled([...this.operations]);
        this.latest.clear();
    }
}
