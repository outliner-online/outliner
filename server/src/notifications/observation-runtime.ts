import { randomUUID } from "node:crypto";
import type { NotificationRule } from "../../../shared/src/notifications/notification-settings.js";
import { retainedJsonBytes } from "./observation-memory.js";
import {
    type CurrentViewChange,
    type NotificationChannel,
    type PreparedViewChange,
    summarizeViewChange,
    type ViewChangeAttemptOutcome,
    type ViewChangeCurrentness,
    type ViewChangePayload,
    type ViewChangeRevalidation,
} from "./prepared-view-change.js";
import type { NotificationSettingsService } from "./settings-service.js";
import type { DiscoveredNotificationRule, NotificationRuleCursor } from "./settings-store.js";
import type {
    ReadSnapshotResult,
    ViewObservationHandle,
    ViewObservationService,
    VisibleProjection,
} from "./view-observation.js";

const CHANNELS: readonly NotificationChannel[] = ["mcp", "mobile"];
const ENTRY_BYTES = 16_384;
const ATTEMPT_BYTES = 2_048;
export const DEFAULT_OBSERVATION_LIMITS = Object.freeze({
    maxAdmissions: 32,
    maxPerOwner: 8,
    maxConcurrentEvaluations: 2,
    maxRetainedBytes: 16 * 1024 * 1024,
    maxProjectionBytes: 512 * 1024,
    discoveryPageSize: 16,
    maxPendingAttempts: 64,
});
export type ObservationLimits = { readonly [Key in keyof typeof DEFAULT_OBSERVATION_LIMITS]: number; };
export interface ObservationClock {
    now(): number;
    setTimeout(callback: () => void, milliseconds: number): unknown;
    clearTimeout(timer: unknown): void;
}
export interface ObservationRuntimeOptions {
    limits?: Partial<ObservationLimits>;
    clock?: ObservationClock;
    quietMs?: number;
    maxWaitMs?: number;
    reconcileMs?: number;
    admissionLeaseMs?: number;
    attemptTimeoutMs?: number;
}
export type ObservationStatusReason =
    | "capacity_deferred"
    | "evaluation_error"
    | "incomplete"
    | "source_stale"
    | "forbidden"
    | "not_found"
    | "attempt_pending"
    | "resource_limit"
    | "unavailable";
export interface NotificationObservationStatus {
    readonly ruleId: string;
    readonly channel: NotificationChannel;
    readonly state: "warming" | "watching" | "blocked" | "disabled";
    readonly reason?: ObservationStatusReason;
}
interface Snapshot {
    readonly projection: VisibleProjection;
    readonly serialized: string;
    readonly bytes: number;
}
interface ChannelState {
    generation: number;
    baselineGeneration: number;
    baseline?: Snapshot;
    candidate?: Attempt;
    state: NotificationObservationStatus["state"];
    reason?: ObservationStatusReason;
}
interface Admission {
    readonly key: string;
    readonly uid: string;
    readonly admittedAt: number;
    rule: NotificationRule;
    revision: number;
    generation: number;
    alive: boolean;
    closed: boolean;
    handle?: ViewObservationHandle;
    certifiedToken?: string;
    unsubscribe?: () => void;
    channels: Record<NotificationChannel, ChannelState>;
    dirtySince?: number;
    lastInvalidationAt?: number;
    retryAt: number;
    inFlight: boolean;
    lastEvaluationAt: number;
}
interface Attempt {
    readonly admission: Admission;
    readonly channel: NotificationChannel;
    readonly generation: number;
    readonly baselineGeneration: number;
    readonly prior: Snapshot;
    readonly next: Snapshot;
    readonly payload: ViewChangePayload;
    readonly expiresAt: number;
    readonly bytes: number;
    readonly prepared: PreparedViewChange;
    token: string;
    valid: boolean;
    settled: boolean;
    callbackActive: boolean;
    revalidation?: Promise<ViewChangeRevalidation>;
    invalidation?: Exclude<ViewChangeRevalidation, { status: "current"; }>;
}
type ReadySnapshot = Extract<ReadSnapshotResult, { status: "ready"; }>;
// Ownership is private callback context, never part of the externally safe payload.
type Adapter = (candidate: PreparedViewChange, ownerUid: string) => void | Promise<void>;

/**
 * One server-lifetime, process-local owner of temporal visible differences.
 * There is no waiting-rule map: keyset discovery is the bounded overflow path.
 * Retired admissions and unfinished adapters retain their capacity charges
 * until their asynchronous owners actually release them.
 */
export class NotificationObservationRuntime {
    readonly limits: ObservationLimits;
    private readonly clock: ObservationClock;
    private readonly quietMs: number;
    private readonly maxWaitMs: number;
    private readonly reconcileMs: number;
    private readonly admissionLeaseMs: number;
    private readonly attemptTimeoutMs: number;
    private readonly admissions = new Map<string, Admission>();
    private readonly attempts = new Map<string, Attempt>();
    private readonly adapters = new Map<NotificationChannel, Adapter>();
    private readonly operations = new Set<Promise<unknown>>();
    private cursor?: NotificationRuleCursor;
    private unsubscribeSettings?: () => void;
    private timer?: unknown;
    private timerAt = Infinity;
    private nextReconcile = 0;
    private evaluating = 0;
    private capacityDeferrals = 0;
    private started = false;
    private stopped = false;

    constructor(
        private readonly settings: NotificationSettingsService,
        private readonly observations: Pick<ViewObservationService, "openViewObservation">,
        private readonly canAccess: (uid: string, projectId: string) => Promise<boolean>,
        options: ObservationRuntimeOptions = {},
    ) {
        this.limits = { ...DEFAULT_OBSERVATION_LIMITS, ...options.limits };
        for (const value of Object.values(this.limits)) positiveInteger(value);
        if (this.limits.discoveryPageSize > 128) throw new Error("discoveryPageSize exceeds 128");
        this.quietMs = positiveInteger(options.quietMs ?? 5_000);
        this.maxWaitMs = positiveInteger(options.maxWaitMs ?? 30_000);
        this.reconcileMs = positiveInteger(options.reconcileMs ?? 1_000);
        this.admissionLeaseMs = positiveInteger(options.admissionLeaseMs ?? 300_000);
        this.attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs ?? 30_000);
        this.clock = options.clock ?? {
            now: Date.now,
            setTimeout: (callback, milliseconds) => {
                const timer = setTimeout(callback, milliseconds);
                timer.unref();
                return timer;
            },
            clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        };
    }

    start(): void {
        if (this.started || this.stopped) return;
        this.started = true;
        // Commit callbacks fence capabilities synchronously, before an adapter
        // can cross its next synchronous outbound-write boundary.
        this.unsubscribeSettings = this.settings.onCommittedChange(({ uid }) => {
            this.refreshOwner(uid);
            this.nextReconcile = this.clock.now();
            this.schedule();
        });
        this.schedule();
    }

    subscribe(channel: NotificationChannel, adapter: Adapter): () => void {
        if (this.stopped) throw new Error("notification observation runtime is closed");
        if (this.adapters.has(channel)) throw new Error("one adapter may own each notification channel");
        this.adapters.set(channel, adapter);
        return () => {
            if (this.adapters.get(channel) === adapter) this.adapters.delete(channel);
        };
    }

    /** One bounded durable-discovery page, also used after storage becomes ready. */
    async reconcile(): Promise<void> {
        if (this.stopped) return;
        this.nextReconcile = this.clock.now() + this.reconcileMs;
        const owners = new Set([...this.admissions.values()].filter(entry => entry.alive).map(entry => entry.uid));
        for (const uid of owners) this.refreshOwner(uid);
        for (const entry of this.admissions.values()) {
            // A replacement serving-room incarnation need not emit an update
            // on the detached old document. Currency only schedules a fresh
            // authoritative read; it never proves a semantic difference.
            if (
                entry.alive && !entry.inFlight && entry.dirtySince === undefined
                && entry.handle && entry.certifiedToken && !entry.handle.isCurrent(entry.certifiedToken)
            ) {
                this.dirty(entry);
            }
        }
        try {
            const page = this.settings.store.listEnabledPage({
                after: this.cursor,
                limit: this.limits.discoveryPageSize,
            });
            let processed = this.cursor;
            let deferred = false;
            for (const row of page.entries) {
                const key = admissionKey(row.uid, row.rule.ruleId);
                if (
                    (row.rule.channels.mcp || row.rule.channels.mobile) && !this.admissions.has(key)
                    && !this.admit(row)
                ) {
                    // Retry this claimant after reclamation. Advancing past it
                    // could readmit an earlier owner on every cursor wrap and
                    // permanently starve the claimant when page size is one.
                    deferred = true;
                    break;
                }
                processed = { uid: row.uid, ruleId: row.rule.ruleId };
            }
            this.cursor = deferred ? processed : page.cursor;
        } catch {
            // Persistence opens asynchronously. Never interpret unavailable
            // configuration as an empty rule set or disable existing rules.
        }
        this.pump();
    }

    /** Owned, bounded status only; no delivery/read/processing claim is made. */
    status(uid: string): readonly NotificationObservationStatus[] {
        const configured = this.settings.get(uid);
        return configured.rules.flatMap(rule => CHANNELS.map(channel => {
            if (!rule.enabled || !rule.channels[channel]) {
                return { ruleId: rule.ruleId, channel, state: "disabled" as const };
            }
            const entry = this.admissions.get(admissionKey(uid, rule.ruleId));
            if (!entry?.alive) {
                return {
                    ruleId: rule.ruleId,
                    channel,
                    state: "blocked" as const,
                    reason: "capacity_deferred" as const,
                };
            }
            const state = entry.channels[channel];
            if (
                state.state === "watching" && entry.handle && entry.certifiedToken
                && !entry.handle.isCurrent(entry.certifiedToken)
            ) {
                return { ruleId: rule.ruleId, channel, state: "blocked" as const, reason: "source_stale" as const };
            }
            return {
                ruleId: rule.ruleId,
                channel,
                state: state.state,
                ...(state.reason ? { reason: state.reason } : {}),
            };
        }));
    }

    diagnostics() {
        return {
            admissions: this.admissions.size,
            evaluating: this.evaluating,
            retainedBytes: this.retainedBytes(),
            candidates: this.attempts.size,
            dirty: [...this.admissions.values()].filter(entry => entry.dirtySince !== undefined).length,
            handles: [...this.admissions.values()].filter(entry => entry.handle !== undefined).length,
            timers: this.timer === undefined ? 0 : 1,
            discoveryEntries: 0,
            capacityDeferrals: this.capacityDeferrals,
        };
    }

    /** Explicitly abandon an admission; rediscovery always starts a new baseline. */
    reclaim(uid: string, ruleId: string): void {
        const entry = this.admissions.get(admissionKey(uid, ruleId));
        if (entry) this.retire(entry);
    }

    async close(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.unsubscribeSettings?.();
        this.unsubscribeSettings = undefined;
        if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
        this.timer = undefined;
        for (const entry of this.admissions.values()) this.retire(entry);
        // Source work is bounded by the evaluation/admission caps. External
        // adapters are fenced, but do not keep shutdown waiting on a provider.
        while (this.operations.size) await Promise.allSettled([...this.operations]);
        this.admissions.clear();
        this.attempts.clear();
        this.adapters.clear();
        this.cursor = undefined;
    }

    private admit(row: DiscoveredNotificationRule): boolean {
        const requiredBytes = ENTRY_BYTES + this.limits.maxProjectionBytes + jsonBytes(row.rule);
        if (requiredBytes > this.limits.maxRetainedBytes) {
            // A permanently oversized rule cannot hold the discovery cursor
            // in front of later rules that could fit.
            this.defer();
            return true;
        }
        const owned = [...this.admissions.values()].filter(entry => entry.uid === row.uid);
        if (owned.length >= this.limits.maxPerOwner) {
            const oldest = owned.filter(entry => entry.alive).sort((a, b) => a.admittedAt - b.admittedAt)[0];
            if (oldest && this.clock.now() - oldest.admittedAt >= this.admissionLeaseMs) this.retire(oldest);
            this.defer();
            return false;
        }
        if (this.admissions.size >= this.limits.maxAdmissions || !this.hasMemory(requiredBytes)) {
            // A bounded lease rotation makes discovery fair even when the
            // same early owners keep their durable rules enabled forever.
            const oldest = [...this.admissions.values()].filter(entry => entry.alive)
                .sort((a, b) => a.admittedAt - b.admittedAt)[0];
            if (oldest && this.clock.now() - oldest.admittedAt >= this.admissionLeaseMs) this.retire(oldest);
            this.defer();
            return false;
        }
        const channel = (enabled: boolean): ChannelState => ({
            generation: 1,
            baselineGeneration: 0,
            state: enabled ? "warming" : "disabled",
        });
        const entry: Admission = {
            key: admissionKey(row.uid, row.rule.ruleId),
            uid: row.uid,
            rule: row.rule,
            revision: row.revision,
            admittedAt: this.clock.now(),
            generation: 1,
            alive: true,
            closed: false,
            channels: { mcp: channel(row.rule.channels.mcp), mobile: channel(row.rule.channels.mobile) },
            dirtySince: this.clock.now(),
            lastInvalidationAt: this.clock.now() - this.quietMs,
            retryAt: 0,
            inFlight: false,
            lastEvaluationAt: -Infinity,
        };
        this.admissions.set(entry.key, entry);
        return true;
    }

    private refreshOwner(uid: string): void {
        let current: ReturnType<NotificationSettingsService["get"]>;
        try {
            current = this.settings.get(uid);
        } catch {
            for (const entry of this.admissions.values()) {
                if (entry.uid === uid && entry.alive) this.block(entry, "unavailable");
            }
            return;
        }
        for (const entry of this.admissions.values()) {
            if (!entry.alive || entry.uid !== uid) continue;
            const rule = current.rules.find(rule => rule.ruleId === entry.rule.ruleId);
            if (
                !rule?.enabled || (!rule.channels.mcp && !rule.channels.mobile)
                || identity(rule) !== identity(entry.rule)
            ) {
                this.retire(entry);
                continue;
            }
            if (entry.revision === current.revision) continue;
            if (!this.hasMemory(Math.max(0, jsonBytes(rule) - jsonBytes(entry.rule)))) {
                this.retire(entry);
                this.defer();
                continue;
            }
            for (const channel of CHANNELS) {
                const state = entry.channels[channel];
                if (state.candidate) this.invalidate(state.candidate, "cancelled", "revoked");
                if (rule.channels[channel] !== entry.rule.channels[channel]) {
                    state.generation++;
                    state.baselineGeneration++;
                    state.baseline = undefined;
                    state.candidate = undefined;
                    state.state = rule.channels[channel] ? "warming" : "disabled";
                    state.reason = undefined;
                }
            }
            entry.rule = rule;
            entry.revision = current.revision;
            this.dirty(entry, true);
        }
    }

    private dirty(entry: Admission, immediate = false): void {
        if (!entry.alive || this.stopped) return;
        const now = this.clock.now();
        entry.dirtySince ??= now;
        entry.lastInvalidationAt = immediate ? now - this.quietMs : now;
        entry.retryAt = 0;
        this.schedule();
    }

    private dueAt(entry: Admission): number {
        if (!entry.alive || entry.inFlight || entry.dirtySince === undefined) return Infinity;
        return Math.max(entry.retryAt, Math.min(
            (entry.lastInvalidationAt ?? entry.dirtySince) + this.quietMs,
            entry.dirtySince + this.maxWaitMs,
        ));
    }

    private pump(): void {
        if (this.stopped) return;
        const now = this.clock.now();
        const due = [...this.admissions.values()].filter(entry => this.dueAt(entry) <= now)
            .sort((a, b) => a.lastEvaluationAt - b.lastEvaluationAt);
        for (const entry of due) {
            if (this.evaluating >= this.limits.maxConcurrentEvaluations) {
                this.block(entry, "capacity_deferred", false);
                this.defer();
                continue;
            }
            this.launch(entry);
        }
        this.schedule();
    }

    private schedule(): void {
        if (!this.started || this.stopped) return;
        let at = this.nextReconcile;
        if (this.evaluating < this.limits.maxConcurrentEvaluations) {
            for (const entry of this.admissions.values()) at = Math.min(at, this.dueAt(entry));
        }
        if (this.timer !== undefined && this.timerAt <= at) return;
        if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
        this.timerAt = at;
        this.timer = this.clock.setTimeout(() => {
            this.timer = undefined;
            this.timerAt = Infinity;
            if (this.clock.now() >= this.nextReconcile) void this.reconcile();
            else this.pump();
        }, Math.max(0, at - this.clock.now()));
    }

    private launch(entry: Admission): void {
        entry.inFlight = true;
        entry.lastEvaluationAt = this.clock.now();
        this.evaluating++;
        const operation = this.evaluate(entry).then(offers => {
            entry.inFlight = false;
            this.evaluating--;
            this.finalizeRetirement(entry);
            for (const offer of offers) this.offer(offer);
            this.pump();
        }, () => {
            entry.inFlight = false;
            this.evaluating--;
            if (entry.alive) this.block(entry, "evaluation_error");
            this.finalizeRetirement(entry);
            this.schedule();
        });
        this.track(operation);
    }

    private async evaluate(entry: Admission): Promise<Attempt[]> {
        if (!entry.alive || this.stopped) return [];
        const generation = entry.generation;
        entry.dirtySince = undefined;
        entry.lastInvalidationAt = undefined;
        try {
            if (!entry.handle) {
                const handle = await this.observations.openViewObservation({
                    uid: entry.uid,
                    target: entry.rule.target,
                    context: entry.rule.context,
                    maxProjectionBytes: this.limits.maxProjectionBytes,
                });
                if (!this.live(entry, generation)) {
                    await handle.close();
                    return [];
                }
                entry.handle = handle;
                entry.unsubscribe = handle.onInvalidate(() => this.dirty(entry));
            }
            const result = await entry.handle.readSnapshot({ observedAtUtcMs: this.clock.now() });
            if (!this.live(entry, generation)) return [];
            if (result.status !== "ready") {
                await this.nonReady(entry, result);
                return [];
            }
            if (!entry.handle.isCurrent(result.versionToken)) {
                this.block(entry, "source_stale");
                return [];
            }
            return this.accept(entry, result);
        } catch (error) {
            if (this.live(entry, generation)) {
                const code = (error as { code?: string; } | undefined)?.code;
                if (code === "forbidden" || code === "not_found") await this.resetSource(entry, code);
                else this.block(entry, "evaluation_error");
            }
            return [];
        }
    }

    private accept(entry: Admission, result: ReadySnapshot): Attempt[] {
        entry.certifiedToken = result.versionToken;
        const serialized = JSON.stringify(result.projection);
        const snapshot: Snapshot = {
            projection: freezeDeep(result.projection),
            serialized,
            bytes: retainedJsonBytes(result.projection) + serialized.length * 2,
        };
        if (snapshot.bytes > this.limits.maxProjectionBytes) {
            this.block(entry, "resource_limit");
            return [];
        }
        const offers: Attempt[] = [];
        for (const channel of CHANNELS) {
            if (!entry.rule.channels[channel]) continue;
            const state = entry.channels[channel];
            if (!state.baseline) {
                if (!this.hasMemory(snapshot.bytes)) {
                    this.blockChannel(state, "capacity_deferred");
                    this.retry(entry);
                    continue;
                }
                state.baseline = snapshot;
                state.state = "watching";
                state.reason = undefined;
                continue;
            }
            if (state.candidate) {
                const captured = state.candidate;
                if (
                    captured.next.serialized === serialized && captured.valid
                    && captured.payload.settingsRevision === entry.revision
                ) {
                    // Ready reads mint a new prerequisite token. Refresh all
                    // equal-payload channel guards together without mutating
                    // the immutable bytes or event ID offered to an adapter.
                    captured.token = result.versionToken;
                } else if (captured.valid) {
                    this.invalidate(captured, captured.prior.serialized === serialized ? "cancelled" : "deferred",
                        captured.prior.serialized === serialized ? "reverted" : "superseded");
                }
                state.state = "watching";
                state.reason = undefined;
                continue;
            }
            if (state.baseline.serialized === serialized) {
                state.state = "watching";
                state.reason = undefined;
                continue;
            }
            const payload: ViewChangePayload = freezeDeep({
                eventId: randomUUID(),
                ruleId: entry.rule.ruleId,
                channel,
                target: { ...entry.rule.target },
                observedAt: new Date(result.observedAtUtcMs).toISOString(),
                settingsRevision: entry.revision,
                sourceVersionToken: result.versionToken,
                effectiveContext: structuredClone(result.effectiveContext),
                deepLink: result.deepLink,
                summary: summarizeViewChange(state.baseline.projection, snapshot.projection),
            });
            const bytes = ATTEMPT_BYTES + jsonBytes(payload);
            if (this.attempts.size >= this.limits.maxPendingAttempts || !this.hasMemory(bytes + snapshot.bytes)) {
                this.blockChannel(state, "capacity_deferred");
                this.retry(entry);
                this.defer();
                continue;
            }
            let attempt!: Attempt;
            const prepared: PreparedViewChange = Object.freeze({
                ...payload,
                revalidate: () => this.revalidate(attempt),
                settleAttempt: (outcome: ViewChangeAttemptOutcome) => this.settle(attempt, outcome),
            });
            attempt = {
                admission: entry,
                channel,
                generation: state.generation,
                baselineGeneration: state.baselineGeneration,
                prior: state.baseline,
                next: snapshot,
                payload,
                expiresAt: this.clock.now() + this.attemptTimeoutMs,
                bytes,
                prepared,
                token: result.versionToken,
                valid: true,
                settled: false,
                callbackActive: false,
            };
            state.candidate = attempt;
            state.state = "watching";
            state.reason = undefined;
            this.attempts.set(payload.eventId, attempt);
            offers.push(attempt);
        }
        return offers;
    }

    private offer(attempt: Attempt): void {
        if (attempt.settled) return;
        const adapter = this.adapters.get(attempt.channel);
        if (!adapter) {
            this.settle(attempt, { initiated: false, outcome: "no_destination" });
            return;
        }
        attempt.callbackActive = true;
        // One invocation is the entire best-effort opportunity. A callback
        // may retain the capability, but must eventually aggregate its actual
        // first-write evidence and settle it; merely returning is not evidence.
        Promise.resolve().then(() => adapter(attempt.prepared, attempt.admission.uid)).catch(() => {
            // A thrown adapter cannot prove whether any request wrote bytes.
            // Fence later writes and retain the bounded attempt until explicit
            // settlement supplies its evidence; never fabricate zero writes.
            this.invalidate(attempt, "deferred", "adapter_error");
            const state = attempt.admission.channels[attempt.channel];
            if (state.candidate === attempt) this.blockChannel(state, "attempt_pending");
        }).finally(() => {
            attempt.callbackActive = false;
            if (attempt.settled) this.attempts.delete(attempt.payload.eventId);
            this.schedule();
        });
    }

    private revalidate(attempt: Attempt): Promise<ViewChangeRevalidation> {
        // Multiple destinations of one candidate share one live revalidation,
        // rather than invalidate each other or create a per-destination queue.
        if (attempt.revalidation) return attempt.revalidation;
        const operation = this.revalidateExclusive(attempt);
        attempt.revalidation = operation;
        void operation.finally(() => {
            if (attempt.revalidation === operation) attempt.revalidation = undefined;
        }).catch(() => undefined);
        return operation;
    }

    private async revalidateExclusive(attempt: Attempt): Promise<ViewChangeRevalidation> {
        const entry = attempt.admission;
        if (!this.authorized(attempt)) return this.refusal(attempt);
        if (this.clock.now() >= attempt.expiresAt) {
            // Expiry closes the send lease, not the semantic opportunity. A
            // terminal zero-write expiry can still settle current B once.
            return { status: "cancelled", reason: "expired" };
        }
        if (entry.inFlight || this.evaluating >= this.limits.maxConcurrentEvaluations) {
            // Same-attempt callers already share their in-flight operation.
            // A genuinely deferred opportunity cannot later advance via a
            // generic zero-write transport failure reported by an adapter.
            this.invalidate(attempt, "deferred", "capacity_deferred");
            this.dirty(entry, true);
            this.defer();
            return { status: "deferred", reason: "capacity_deferred" };
        }
        entry.inFlight = true;
        this.evaluating++;
        const operation = (async (): Promise<ViewChangeRevalidation> => {
            try {
                // Fresh project authority on every potentially successful
                // revalidation; the final synchronous guard cannot serialize
                // a later external ACL mutation and makes no such claim.
                if (!await this.canAccess(entry.uid, entry.rule.target.projectId)) {
                    if (entry.alive) await this.resetSource(entry, "forbidden");
                    return { status: "cancelled", reason: "forbidden" };
                }
                if (!this.authorized(attempt) || !entry.handle) return this.refusal(attempt);
                const result = await entry.handle.readSnapshot({ observedAtUtcMs: this.clock.now() });
                if (!this.authorized(attempt)) return this.refusal(attempt);
                if (result.status !== "ready") {
                    await this.nonReady(entry, result);
                    return this.refusal(attempt);
                }
                // This final fresh check also covers destinations that joined
                // the shared revalidation while its source read was pending.
                if (!await this.canAccess(entry.uid, entry.rule.target.projectId)) {
                    if (entry.alive) await this.resetSource(entry, "forbidden");
                    return { status: "cancelled", reason: "forbidden" };
                }
                if (!this.authorized(attempt)) return this.refusal(attempt);
                if (!entry.handle?.isCurrent(result.versionToken)) {
                    this.invalidate(attempt, "deferred", "source_stale");
                    this.dirty(entry);
                    return { status: "deferred", reason: "source_stale" };
                }
                // No new offers are expected for this channel while its
                // aggregate outcome is pending. Independent warming channels
                // can baseline, and equal captured guards are refreshed.
                const offers = this.accept(entry, result);
                for (const offer of offers) this.offer(offer);
                if (!this.authorized(attempt)) return this.refusal(attempt);
                const candidate: CurrentViewChange = Object.freeze({
                    ...attempt.payload,
                    isCurrent: () => this.checkCurrent(attempt).status === "current",
                    checkCurrent: () => this.checkCurrent(attempt),
                });
                if (!this.current(attempt)) {
                    return this.invalidate(attempt, "deferred", "source_stale");
                }
                if (this.clock.now() >= attempt.expiresAt) return { status: "cancelled", reason: "expired" };
                return { status: "current", candidate };
            } catch {
                this.invalidate(attempt, "deferred", "evaluation_error");
                if (entry.alive) this.block(entry, "evaluation_error");
                return { status: "deferred", reason: "evaluation_error" };
            }
        })();
        this.track(operation);
        try {
            return await operation;
        } finally {
            entry.inFlight = false;
            this.evaluating--;
            this.finalizeRetirement(entry);
            this.pump();
        }
    }

    private settle(attempt: Attempt, outcome: ViewChangeAttemptOutcome): void {
        if (attempt.settled) return;
        const entry = attempt.admission;
        const state = entry.channels[attempt.channel];
        const sameBaseline = entry.alive && !this.stopped && state.generation === attempt.generation
            && state.baselineGeneration === attempt.baselineGeneration && state.candidate === attempt;
        const terminal = outcome.outcome !== "cancelled" && outcome.outcome !== "deferred";
        const advance = sameBaseline && (outcome.initiated || (terminal && this.current(attempt)));
        attempt.settled = true;
        attempt.valid = false;
        if (advance) {
            state.baseline = attempt.next;
            state.baselineGeneration++;
        }
        if (state.candidate === attempt) {
            state.candidate = undefined;
            state.state = entry.rule.channels[attempt.channel] ? (state.baseline ? "watching" : "warming") : "disabled";
            state.reason = undefined;
        }
        if (!attempt.callbackActive) this.attempts.delete(attempt.payload.eventId);
        if (sameBaseline) this.dirty(entry, true);
        this.schedule();
    }

    private authorized(attempt: Attempt): boolean {
        return attempt.valid && this.ownsAttempt(attempt);
    }

    private ownsAttempt(attempt: Attempt): boolean {
        const entry = attempt.admission;
        const state = entry.channels[attempt.channel];
        return !this.stopped && entry.alive && !attempt.settled
            && entry.rule.enabled && entry.rule.channels[attempt.channel]
            && entry.revision === attempt.payload.settingsRevision
            && state.generation === attempt.generation && state.baselineGeneration === attempt.baselineGeneration
            && state.candidate === attempt;
    }

    private invalidate(
        attempt: Attempt,
        status: "cancelled" | "deferred",
        reason: string,
    ): Exclude<ViewChangeRevalidation, { status: "current"; }> {
        attempt.valid = false;
        attempt.invalidation = { status, reason };
        return attempt.invalidation;
    }

    private refusal(attempt: Attempt): Exclude<ViewChangeRevalidation, { status: "current"; }> {
        return this.ownsAttempt(attempt) && attempt.invalidation
            ? attempt.invalidation
            : { status: "cancelled", reason: "revoked" };
    }

    private current(attempt: Attempt): boolean {
        return this.authorized(attempt) && Boolean(attempt.admission.handle?.isCurrent(attempt.token));
    }

    private checkCurrent(attempt: Attempt): ViewChangeCurrentness {
        if (!this.authorized(attempt)) return this.refusal(attempt);
        if (!attempt.admission.handle?.isCurrent(attempt.token)) {
            return { status: "deferred", reason: "source_stale" };
        }
        // Only a still-current semantic opportunity expires terminally. The
        // adapter must not turn lease expiry into a retry of unchanged content.
        if (this.clock.now() >= attempt.expiresAt) return { status: "cancelled", reason: "expired" };
        return { status: "current" };
    }

    private async nonReady(entry: Admission, result: Exclude<ReadSnapshotResult, { status: "ready"; }>): Promise<void> {
        if (result.status === "stale" && result.reason === "incarnation_lost") {
            await this.resetSource(entry, "source_stale");
        } else if (result.status === "forbidden" || result.status === "not_found") {
            await this.resetSource(entry, result.status);
        } else {
            this.block(entry, result.reason === "resource_limit"
                ? "resource_limit"
                : result.status === "stale"
                ? "source_stale"
                : result.status === "incomplete"
                ? "incomplete"
                : "evaluation_error");
        }
    }

    private async resetSource(entry: Admission, reason: ObservationStatusReason): Promise<void> {
        entry.generation++;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        const handle = entry.handle;
        entry.handle = undefined;
        entry.certifiedToken = undefined;
        for (const channel of CHANNELS) {
            const state = entry.channels[channel];
            if (state.candidate) this.invalidate(state.candidate, "cancelled", reason);
            state.generation++;
            state.baselineGeneration++;
            state.baseline = undefined;
            state.candidate = undefined;
            if (entry.rule.channels[channel]) this.blockChannel(state, reason);
        }
        this.retry(entry);
        await handle?.close();
    }

    private block(entry: Admission, reason: ObservationStatusReason, invalidate = true): void {
        if (!entry.alive) return;
        for (const channel of CHANNELS) {
            if (!entry.rule.channels[channel]) continue;
            const state = entry.channels[channel];
            if (invalidate && state.candidate) this.invalidate(state.candidate, "deferred", reason);
            this.blockChannel(state, reason);
        }
        if (invalidate) this.retry(entry);
    }

    private blockChannel(state: ChannelState, reason: ObservationStatusReason): void {
        state.state = "blocked";
        state.reason = reason;
    }

    private retry(entry: Admission): void {
        if (!entry.alive) return;
        const now = this.clock.now();
        entry.dirtySince ??= now;
        entry.lastInvalidationAt ??= now;
        entry.retryAt = now + Math.max(this.quietMs, this.reconcileMs);
    }

    private retire(entry: Admission): void {
        if (!entry.alive) return;
        entry.alive = false;
        entry.generation++;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        entry.dirtySince = undefined;
        for (const channel of CHANNELS) {
            const state = entry.channels[channel];
            if (state.candidate) this.invalidate(state.candidate, "cancelled", "revoked");
            state.generation++;
            state.baseline = undefined;
            state.candidate = undefined;
        }
        const handle = entry.handle;
        entry.handle = undefined;
        entry.certifiedToken = undefined;
        const cleanup = Promise.resolve().then(() => handle?.close()).finally(() => {
            entry.closed = true;
            this.finalizeRetirement(entry);
        });
        this.track(cleanup);
    }

    private finalizeRetirement(entry: Admission): void {
        if (entry.alive || !entry.closed || entry.inFlight) return;
        if (this.admissions.get(entry.key) === entry) this.admissions.delete(entry.key);
        this.nextReconcile = this.clock.now();
        this.schedule();
    }

    private live(entry: Admission, generation: number): boolean {
        return !this.stopped && entry.alive && entry.generation === generation;
    }

    private retainedBytes(): number {
        let bytes = 0;
        const retainedAdmissions = new Set(this.admissions.values());
        const snapshots = new Set<Snapshot>();
        for (const attempt of this.attempts.values()) retainedAdmissions.add(attempt.admission);
        for (const entry of retainedAdmissions) {
            // The producer retains its own bounded capture in addition to the
            // runtime's settled/candidate snapshots. Retired admission metadata
            // also remains reachable until its last attempt/callback releases.
            bytes += ENTRY_BYTES + jsonBytes(entry.rule);
            if (!entry.closed || entry.inFlight) bytes += this.limits.maxProjectionBytes;
            for (const channel of CHANNELS) {
                const baseline = entry.channels[channel].baseline;
                if (baseline) snapshots.add(baseline);
            }
        }
        for (const attempt of this.attempts.values()) {
            bytes += attempt.bytes;
            snapshots.add(attempt.prior);
            snapshots.add(attempt.next);
        }
        for (const snapshot of snapshots) bytes += snapshot.bytes;
        return bytes;
    }

    private hasMemory(additional: number): boolean {
        return this.retainedBytes() + additional <= this.limits.maxRetainedBytes;
    }

    private defer(): void {
        this.capacityDeferrals = Math.min(Number.MAX_SAFE_INTEGER, this.capacityDeferrals + 1);
    }

    private track(operation: Promise<unknown>): void {
        this.operations.add(operation);
        void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    }
}

function admissionKey(uid: string, ruleId: string): string {
    return JSON.stringify([uid, ruleId]);
}
function identity(rule: NotificationRule): string {
    return JSON.stringify([rule.target, rule.context]);
}
function positiveInteger(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("observation limits must be finite positive integers");
    }
    return value;
}
function jsonBytes(value: unknown): number {
    return retainedJsonBytes(value);
}
function freezeDeep<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freezeDeep(child);
    }
    return value;
}
