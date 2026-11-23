import type { Hocuspocus } from "@hocuspocus/server";
import crypto from "node:crypto";
import * as Y from "yjs";
import type {
    CalendarObservationContextV1,
    CalendarVisibleProjection,
} from "../../../shared/src/notifications/calendarProjection.js";
import { validateCalendarObservationContext } from "../../../shared/src/notifications/calendarProjection.js";
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
    ) {
        this.openers = {
            kanban: kanbanOpener(kanbanHost, canAccess),
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

    constructor(
        private readonly input: { uid: string; target: TargetRef; context: ObservationContext; },
        private readonly producer: CapturedViewProducer,
        private readonly canAccess: (uid: string, projectId: string) => Promise<boolean>,
    ) {
        // Subscribe before the first capture. A generation check below closes
        // the gap across every asynchronous producer/access step.
        for (const doc of producer.documents) {
            const listener = () => {
                if (this.closed) return;
                this.generation++;
                for (const callback of [...this.callbacks]) callback();
            };
            doc.on("update", listener);
            this.listeners.push({ doc, listener });
        }
    }

    async readSnapshot({ observedAtUtcMs }: { observedAtUtcMs: number; }): Promise<ReadSnapshotResult> {
        if (this.closed) return { status: "stale", reason: "closed" };
        if (!Number.isFinite(observedAtUtcMs)) return { status: "unavailable", reason: "invalid_observation_time" };
        if (!await this.canAccess(this.input.uid, this.input.target.projectId)) {
            return { status: "forbidden", reason: "access_revoked" };
        }
        const generation = this.generation;
        const result = await this.producer.read(observedAtUtcMs);
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
    return `/${encodeURIComponent(target.projectId)}/-/${plural}/${
        encodeURIComponent(target.objectId)
    }?observationContext=${encodeURIComponent(JSON.stringify(context))}`;
}

function kanbanOpener(
    host: Pick<Hocuspocus, "openDirectConnection"> & Partial<Pick<Hocuspocus, "documents">>,
    canAccess: (uid: string, projectId: string) => Promise<boolean>,
): ViewProducerOpener {
    return async ({ uid, target, context }) => {
        const observed = await new OutlinerKanbanQueryService(host, canAccess).openObservation(
            uid,
            target.projectId,
            target.objectId,
        );
        const documents = [observed.handles.project, ...observed.handles.sources.values()]
            .map(connection => connection.document as unknown as Y.Doc);
        return {
            documents,
            async read() {
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
                return observed.isCurrent() && revision === observationRevision(documents);
            },
            close: () => observed.release(),
        };
    };
}

function observationRevision(documents: readonly Y.Doc[]): string {
    const hash = crypto.createHash("sha256");
    for (const doc of documents) hash.update(Buffer.from(Y.encodeStateAsUpdate(doc)));
    return hash.digest("base64url");
}
