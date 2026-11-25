import type { Hocuspocus } from "@hocuspocus/server";
import crypto from "node:crypto";
import * as Y from "yjs";
import type {
    CalendarObservationContextV1,
    CalendarVisibleProjection,
} from "../../../shared/src/notifications/calendarProjection.js";
import {
    encodeCalendarObservationContext,
    validateCalendarObservationContext,
} from "../../../shared/src/notifications/calendarProjection.js";
import type {
    GridObservationContextV1,
    GridVisibleProjection,
} from "../../../shared/src/notifications/gridProjection.js";
import type {
    KanbanObservationContextV1,
    KanbanVisibleProjection,
} from "../../../shared/src/notifications/kanbanProjection.js";
import {
    createKanbanVisibleProjection,
    isKanbanObservationContextV1,
} from "../../../shared/src/notifications/kanbanProjection.js";
import { OutlinerKanbanQueryService } from "../mcp/kanban-query-service.js";
import { McpReadError } from "../mcp/mcp-error.js";
import { savedViewOpener } from "./saved-view-producer.js";

export type ViewKind = "grid" | "calendar" | "kanban";
export interface TargetRef {
    readonly projectId: string;
    readonly kind: ViewKind;
    readonly objectId: string;
}
export type ObservationContext = GridObservationContextV1 | CalendarObservationContextV1 | KanbanObservationContextV1;
export type VisibleProjection = GridVisibleProjection | CalendarVisibleProjection | KanbanVisibleProjection;

export type ReadSnapshotResult =
    | {
        readonly status: "ready";
        readonly projection: VisibleProjection;
        readonly versionToken: string;
        readonly effectiveContext: ObservationContext;
        readonly deepLink: string;
        readonly observedAtUtcMs: number;
    }
    | {
        readonly status: "stale" | "incomplete" | "unavailable" | "not_found" | "forbidden";
        readonly reason: string;
    };

export interface ViewObservationHandle {
    readSnapshot(input: { readonly observedAtUtcMs: number; }): Promise<ReadSnapshotResult>;
    onInvalidate(callback: () => void): () => void;
    isCurrent(versionToken: string): boolean;
    close(): Promise<void>;
}

/**
 * A complete captured producer. Implementations own their live rooms and must
 * certify all awaited materialisation before returning `ready`.
 */
export interface CapturedViewProducer {
    readonly documents: readonly Y.Doc[];
    read(observedAtUtcMs: number): Promise<
        | { readonly status: "ready"; readonly projection: VisibleProjection; readonly revision: string; }
        | Exclude<ReadSnapshotResult, { status: "ready"; }>
    >;
    isCurrent(revision: string): boolean;
    close(): Promise<void>;
}

export type ViewProducerOpener = (input: {
    readonly uid: string;
    readonly target: TargetRef;
    readonly context: ObservationContext;
}) => Promise<CapturedViewProducer>;

const ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Retained, browser-independent visible-view observation service. */
export class ViewObservationService {
    private readonly openers: Readonly<Partial<Record<ViewKind, ViewProducerOpener>>>;

    constructor(
        kanbanHost: Pick<Hocuspocus, "openDirectConnection"> & Partial<Pick<Hocuspocus, "documents">>,
        private readonly canAccess: (uid: string, projectId: string) => Promise<boolean>,
        openers: Partial<Record<ViewKind, ViewProducerOpener>> = {},
        kanbanOptions: ConstructorParameters<typeof OutlinerKanbanQueryService>[2] = {},
    ) {
        this.openers = {
            grid: savedViewOpener(kanbanHost, canAccess, "grid", kanbanOptions),
            calendar: savedViewOpener(kanbanHost, canAccess, "calendar", kanbanOptions),
            kanban: kanbanOpener(kanbanHost, canAccess, kanbanOptions),
            ...openers,
        };
    }

    async openViewObservation(input: {
        readonly uid: string;
        readonly target: TargetRef;
        readonly context: ObservationContext;
    }): Promise<ViewObservationHandle> {
        validateRequest(input.target, input.context);
        if (!await this.canAccess(input.uid, input.target.projectId)) {
            throw new McpReadError("forbidden", "Project is inaccessible");
        }
        const opener = this.openers[input.target.kind];
        if (!opener) throw new McpReadError("invalid_argument", `${input.target.kind} observation is unavailable`);
        const producer = await opener(input);
        return new RetainedViewObservation(input, producer, this.canAccess);
    }
}

class RetainedViewObservation implements ViewObservationHandle {
    private readonly nonce = crypto.randomBytes(18).toString("base64url");
    private readonly callbacks = new Set<() => void>();
    private readonly revisions = new Map<string, string>();
    private readonly listeners: { doc: Y.Doc; listener: () => void; }[] = [];
    private generation = 0;
    private closed = false;
    private readTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly input: { uid: string; target: TargetRef; context: ObservationContext; },
        private readonly producer: CapturedViewProducer,
        private readonly canAccess: (uid: string, projectId: string) => Promise<boolean>,
    ) {
        // Subscribe before the first capture. A generation check below closes
        // the gap across every asynchronous producer/access step.
        this.synchronizeListeners();
    }

    private synchronizeListeners(): void {
        for (const doc of this.producer.documents) {
            if (this.listeners.some(candidate => candidate.doc === doc)) continue;
            const listener = () => {
                if (this.closed) return;
                this.generation++;
                for (const callback of [...this.callbacks]) callback();
            };
            doc.on("update", listener);
            this.listeners.push({ doc, listener });
        }
    }

    readSnapshot(input: { observedAtUtcMs: number; }): Promise<ReadSnapshotResult> {
        const read = this.readTail.then(() => this.readSnapshotExclusive(input));
        // Serialize captures so an older concurrent refresh can never install
        // after a newer one or leave its candidate lease unowned.
        this.readTail = read.then(() => undefined, () => undefined);
        return read;
    }

    private async readSnapshotExclusive(
        { observedAtUtcMs }: { observedAtUtcMs: number; },
    ): Promise<ReadSnapshotResult> {
        if (this.closed) return { status: "stale", reason: "closed" };
        if (!Number.isFinite(observedAtUtcMs)) return { status: "unavailable", reason: "invalid_observation_time" };
        if (!await this.canAccess(this.input.uid, this.input.target.projectId)) {
            return { status: "forbidden", reason: "access_revoked" };
        }
        const generation = this.generation;
        const result = await this.producer.read(observedAtUtcMs);
        // close() removes every listener while producer.read() may still be
        // awaited. Never rediscover producer documents after that boundary.
        if (this.closed) return { status: "stale", reason: "closed" };
        this.synchronizeListeners();
        if (result.status !== "ready") return result;
        if (this.closed || generation !== this.generation || !this.producer.isCurrent(result.revision)) {
            return { status: "stale", reason: "inputs_changed" };
        }
        if (!await this.canAccess(this.input.uid, this.input.target.projectId)) {
            return { status: "forbidden", reason: "access_revoked" };
        }
        if (this.closed || generation !== this.generation || !this.producer.isCurrent(result.revision)) {
            return { status: "stale", reason: "inputs_changed" };
        }
        const versionToken = `${this.nonce}.${crypto.randomBytes(18).toString("base64url")}`;
        this.revisions.clear();
        this.revisions.set(versionToken, result.revision);
        return {
            status: "ready",
            projection: result.projection,
            versionToken,
            effectiveContext: this.input.context,
            deepLink: deepLink(this.input.target, this.input.context),
            observedAtUtcMs,
        };
    }

    onInvalidate(callback: () => void): () => void {
        if (this.closed) return () => {};
        this.callbacks.add(callback);
        return () => this.callbacks.delete(callback);
    }

    isCurrent(versionToken: string): boolean {
        const revision = this.revisions.get(versionToken);
        return !this.closed && revision !== undefined && this.producer.isCurrent(revision);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.callbacks.clear();
        this.revisions.clear();
        for (const { doc, listener } of this.listeners) doc.off("update", listener);
        this.listeners.length = 0;
        await this.producer.close();
    }
}

function validateRequest(target: TargetRef, context: ObservationContext): void {
    if (!ID.test(target.projectId) || !ID.test(target.objectId)) {
        throw new McpReadError("invalid_argument", "Invalid project or view ID");
    }
    if (target.kind === "grid") {
        if (context.version !== 1 || !("surface" in context) || context.surface !== "table") invalidContext();
    } else if (target.kind === "kanban") {
        if (!isKanbanObservationContextV1(context)) invalidContext();
    } else if (target.kind === "calendar") {
        if (!validateCalendarObservationContext(context).valid) invalidContext();
    } else throw new McpReadError("invalid_argument", "Unsupported view kind");
}

function invalidContext(): never {
    throw new McpReadError("invalid_argument", "Observation context does not match the target kind");
}

function deepLink(target: TargetRef, context: ObservationContext): string {
    const plural = target.kind === "kanban" ? "kanbans" : `${target.kind}s`;
    const parameters = new URLSearchParams();
    if (target.kind === "kanban") {
        const kanban = context as KanbanObservationContextV1;
        parameters.set("surface", kanban.surface);
        parameters.set("version", String(kanban.version));
        parameters.set("locale", kanban.locale);
        parameters.set("timeZone", kanban.timeZone);
    } else if (target.kind === "grid") parameters.set("observation", JSON.stringify(context));
    else parameters.set("context", encodeCalendarObservationContext(context as CalendarObservationContextV1));
    return `/${encodeURIComponent(target.projectId)}/-/${plural}/${encodeURIComponent(target.objectId)}?${parameters}`;
}

function kanbanOpener(
    host: Pick<Hocuspocus, "openDirectConnection"> & Partial<Pick<Hocuspocus, "documents">>,
    canAccess: (uid: string, projectId: string) => Promise<boolean>,
    options: ConstructorParameters<typeof OutlinerKanbanQueryService>[2],
): ViewProducerOpener {
    return async ({ uid, target, context }) => {
        const service = new OutlinerKanbanQueryService(host, canAccess, options);
        let observed = await service.openObservation(uid, target.projectId, target.objectId);
        let documents = observationDocuments(observed);
        let closed = false;
        let lifecycleGeneration = 0;
        let terminalReason: "incarnation_lost" | "not_found" | undefined;
        return {
            get documents() {
                return documents;
            },
            async read() {
                if (closed) return { status: "stale", reason: "closed" };
                if (terminalReason === "incarnation_lost") return { status: "stale", reason: terminalReason };
                if (terminalReason === "not_found") return { status: "not_found", reason: terminalReason };
                // Ordinary source/config edits make a completed capture
                // non-current, but do not end observation continuity. Release
                // that immutable capture and reopen against the current live
                // registry before producing the next snapshot.
                if (!observed.isCurrent()) {
                    if (!documentsRetainIncarnation(host, documents)) {
                        terminalReason = "incarnation_lost";
                        await observed.release();
                        return { status: "stale", reason: terminalReason };
                    }
                    const retained = observed;
                    const retainedDocuments = documents;
                    const refreshGeneration = lifecycleGeneration;
                    let candidate: typeof observed;
                    try {
                        // Keep the retained leases alive while opening. This
                        // makes same-room identity comparable across every
                        // await instead of causing our own disconnect/reopen.
                        candidate = await service.openObservation(uid, target.projectId, target.objectId);
                    } catch (error) {
                        if (error instanceof McpReadError && error.code === "not_found") {
                            terminalReason = "not_found";
                            await retained.release();
                            return { status: "not_found", reason: terminalReason };
                        }
                        if (error instanceof McpReadError && error.code === "forbidden") {
                            return { status: "forbidden", reason: "access_revoked" };
                        }
                        throw error;
                    }
                    if (
                        closed || lifecycleGeneration !== refreshGeneration
                        || !documentsRetainIncarnation(host, retainedDocuments)
                    ) {
                        terminalReason = closed ? undefined : "incarnation_lost";
                        await candidate.release();
                        await retained.release();
                        return { status: "stale", reason: closed ? "closed" : "incarnation_lost" };
                    }
                    const candidateDocuments = observationDocuments(candidate);
                    if (
                        closed || lifecycleGeneration !== refreshGeneration
                        || retained.definitionIdentity !== candidate.definitionIdentity
                        || !authoritiesPreserveContinuity(retainedDocuments, candidateDocuments)
                        || !documentsRetainIncarnation(host, candidateDocuments)
                    ) {
                        terminalReason = closed ? undefined : "incarnation_lost";
                        await candidate.release();
                        await retained.release();
                        return { status: "stale", reason: closed ? "closed" : "incarnation_lost" };
                    }
                    observed = candidate;
                    documents = candidateDocuments;
                    await retained.release();
                }
                if (observed.status !== "success" || !observed.settings) {
                    return {
                        status: observed.status === "incomplete" ? "incomplete" : "unavailable",
                        reason: observed.reason ?? observed.status,
                    };
                }
                if (!observed.isCurrent()) return { status: "stale", reason: "inputs_changed" };
                const rows = observed.lanes.flatMap(lane => lane.cards.map(card => card.row));
                const projected = createKanbanVisibleProjection({
                    rows,
                    settings: observed.settings,
                    declaredGroupingChoices: observed.lanes.map(lane => lane.key),
                    columns: observed.columns.map(column => column.name),
                    readiness: { status: "ready", complete: true, current: true },
                }, context as KanbanObservationContextV1);
                if (projected.status !== "ready") return { status: "unavailable", reason: projected.reason };
                return { status: "ready", projection: projected.content, revision: observationRevision(documents) };
            },
            isCurrent(revision) {
                return !closed && observed.isCurrent() && revision === observationRevision(documents);
            },
            async close() {
                if (closed) return;
                closed = true;
                lifecycleGeneration++;
                await observed.release();
            },
        };
    };
}

function authoritiesPreserveContinuity(retained: readonly Y.Doc[], candidate: readonly Y.Doc[]): boolean {
    const candidateByRoom = new Map(candidate.map(document => [documentRoom(document), document]));
    // Newly relevant Tables may be added. Every authority retained across the
    // refresh must, however, still be the exact same serving-room document.
    return retained.every(document => {
        const replacement = candidateByRoom.get(documentRoom(document));
        return replacement === undefined || replacement === document;
    });
}

function documentRoom(document: Y.Doc): string {
    return (document as Y.Doc & { name?: string; }).name ?? document.guid;
}

function observationDocuments(observed: Awaited<ReturnType<OutlinerKanbanQueryService["openObservation"]>>): Y.Doc[] {
    return [observed.handles.project, ...observed.handles.sources.values()]
        .map(connection => connection.document as unknown as Y.Doc);
}

function documentsRetainIncarnation(
    host: Partial<Pick<Hocuspocus, "documents">>,
    documents: readonly Y.Doc[],
): boolean {
    // A host without an exposed registry cannot prove continuity and must not
    // silently rebind a retained handle to a replacement room incarnation.
    if (!host.documents) return false;
    return documents.every(document => host.documents!.get(documentRoom(document)) === document);
}

function observationRevision(documents: readonly Y.Doc[]): string {
    const hash = crypto.createHash("sha256");
    for (const doc of documents) hash.update(Buffer.from(Y.encodeStateAsUpdate(doc)));
    return hash.digest("base64url");
}
