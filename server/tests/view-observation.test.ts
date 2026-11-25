import { expect } from "chai";
import * as Y from "yjs";
import {
    type GridObservationContextV1,
    parseGridObservationContext,
} from "../../shared/src/notifications/gridProjection.js";
import { parseKanbanObservationContext } from "../../shared/src/notifications/kanbanProjection.js";
import { type CapturedViewProducer, ViewObservationService } from "../src/notifications/view-observation.js";

describe("ViewObservationService retained lifecycle", () => {
    const context: GridObservationContextV1 = {
        version: 1,
        surface: "table",
        locale: "en-US",
        timeZone: "UTC",
    };

    it("invalidates tokens on live updates and releases idempotently", async () => {
        const doc = new Y.Doc();
        let closed = 0;
        const producer: CapturedViewProducer = {
            documents: [doc],
            async read() {
                return {
                    status: "ready",
                    projection: { kind: "grid", title: "Tasks", columns: [], rows: [] },
                    revision: revision(doc),
                };
            },
            isCurrent: candidate => candidate === revision(doc),
            async close() {
                closed++;
            },
        };
        const service = new ViewObservationService({} as never, async () => true, {
            grid: async () => producer,
        });
        const handle = await service.openViewObservation({
            uid: "reader",
            target: { projectId: "project", kind: "grid", objectId: "tasks" },
            context,
        });
        let invalidations = 0;
        handle.onInvalidate(() => invalidations++);
        const first = await handle.readSnapshot({ observedAtUtcMs: 123 });
        expect(first.status).to.equal("ready");
        if (first.status !== "ready") throw new Error("expected ready");
        expect(first.deepLink).to.contain("/project/-/grids/tasks?");
        const gridUrl = new URL(first.deepLink, "https://outliner.example");
        expect(parseGridObservationContext(gridUrl.searchParams.get("observation") ?? undefined)).to.deep.equal({
            status: "supported",
            context,
        });
        expect(handle.isCurrent(first.versionToken)).to.equal(true);

        doc.getMap("source").set("value", 2);
        expect(invalidations).to.equal(1);
        expect(handle.isCurrent(first.versionToken)).to.equal(false);

        await handle.close();
        await handle.close();
        expect(closed).to.equal(1);
        expect((await handle.readSnapshot({ observedAtUtcMs: 124 })).status).to.equal("stale");
    });

    it("withholds a captured projection when final access is revoked", async () => {
        const doc = new Y.Doc();
        let checks = 0;
        const producer: CapturedViewProducer = {
            documents: [doc],
            async read() {
                return {
                    status: "ready",
                    projection: { kind: "grid", title: "Secret", columns: [], rows: [] },
                    revision: revision(doc),
                };
            },
            isCurrent: candidate => candidate === revision(doc),
            async close() {},
        };
        const service = new ViewObservationService({} as never, async () => ++checks < 3, {
            grid: async () => producer,
        });
        const handle = await service.openViewObservation({
            uid: "reader",
            target: { projectId: "project", kind: "grid", objectId: "tasks" },
            context,
        });
        expect((await handle.readSnapshot({ observedAtUtcMs: 123 })).status).to.equal("forbidden");
        await handle.close();
    });

    it("does not reattach listeners when close wins a held producer read", async () => {
        const original = new Y.Doc();
        const arriving = new Y.Doc();
        let documents: readonly Y.Doc[] = [original];
        const held = deferred<Awaited<ReturnType<CapturedViewProducer["read"]>>>();
        const producer: CapturedViewProducer = {
            get documents() {
                return documents;
            },
            read: () => held.promise,
            isCurrent: () => true,
            async close() {},
        };
        const originalBaseline = updateListenerCount(original);
        const arrivingBaseline = updateListenerCount(arriving);
        const service = new ViewObservationService({} as never, async () => true, { grid: async () => producer });
        const handle = await service.openViewObservation({
            uid: "reader",
            target: { projectId: "project", kind: "grid", objectId: "tasks" },
            context,
        });
        expect(updateListenerCount(original)).to.equal(originalBaseline + 1);
        const pending = handle.readSnapshot({ observedAtUtcMs: 123 });
        await Promise.resolve();
        documents = [arriving];
        await handle.close();
        held.resolve({
            status: "ready",
            projection: { kind: "grid", title: "Late", columns: [], rows: [] },
            revision: "late",
        });
        expect(await pending).to.deep.equal({ status: "stale", reason: "closed" });
        expect(updateListenerCount(original)).to.equal(originalBaseline);
        expect(updateListenerCount(arriving)).to.equal(arrivingBaseline);
    });

    it("serializes concurrent reads so captures cannot commit out of order", async () => {
        const doc = new Y.Doc();
        const reads = [
            deferred<Awaited<ReturnType<CapturedViewProducer["read"]>>>(),
            deferred<Awaited<ReturnType<CapturedViewProducer["read"]>>>(),
        ];
        const readStarted = [deferred<void>(), deferred<void>()];
        let started = 0;
        const producer: CapturedViewProducer = {
            documents: [doc],
            read() {
                const index = started++;
                readStarted[index].resolve(undefined);
                return reads[index].promise;
            },
            isCurrent: () => true,
            async close() {},
        };
        const service = new ViewObservationService({} as never, async () => true, { grid: async () => producer });
        const handle = await service.openViewObservation({
            uid: "reader",
            target: { projectId: "project", kind: "grid", objectId: "tasks" },
            context,
        });
        const first = handle.readSnapshot({ observedAtUtcMs: 1 });
        const second = handle.readSnapshot({ observedAtUtcMs: 2 });
        await readStarted[0].promise;
        expect(started).to.equal(1);
        reads[0].resolve({
            status: "ready",
            projection: { kind: "grid", title: "First", columns: [], rows: [] },
            revision: "first",
        });
        expect((await first).status).to.equal("ready");
        await readStarted[1].promise;
        expect(started).to.equal(2);
        reads[1].resolve({
            status: "ready",
            projection: { kind: "grid", title: "Second", columns: [], rows: [] },
            revision: "second",
        });
        const result = await second;
        expect(result.status).to.equal("ready");
        if (result.status === "ready") expect((result.projection as { title: string; }).title).to.equal("Second");
        await handle.close();
    });

    it("round-trips Kanban context through the production route parser", async () => {
        const doc = new Y.Doc();
        const producer: CapturedViewProducer = {
            documents: [doc],
            async read() {
                return {
                    status: "ready",
                    projection: { kind: "kanban", title: "Board", lanes: [] },
                    revision: revision(doc),
                };
            },
            isCurrent: candidate => candidate === revision(doc),
            async close() {},
        };
        const service = new ViewObservationService({} as never, async () => true, {
            kanban: async () => producer,
        });
        const context = { version: 1, surface: "board", locale: "ja-JP", timeZone: "Asia/Tokyo" } as const;
        const handle = await service.openViewObservation({
            uid: "reader",
            target: { projectId: "project", kind: "kanban", objectId: "board" },
            context,
        });
        const result = await handle.readSnapshot({ observedAtUtcMs: 123 });
        expect(result.status).to.equal("ready");
        if (result.status !== "ready") throw new Error("expected ready");
        const parsed = parseKanbanObservationContext(new URL(result.deepLink, "https://outliner.example").searchParams);
        expect(parsed).to.deep.equal({ status: "valid", context });
        await handle.close();
    });
});

function revision(doc: Y.Doc): string {
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64url");
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
}

function updateListenerCount(doc: Y.Doc): number {
    return ((doc as unknown as { _observers: Map<string, Set<unknown>>; })._observers.get("update")?.size) ?? 0;
}
