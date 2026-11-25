import { expect } from "chai";
import * as Y from "yjs";
import type { KanbanObservationContextV1 } from "../../shared/src/notifications/kanbanProjection.js";
import { createKanbanEntry } from "../../shared/src/services/kanbanDefinition.js";
import { releaseWithoutStore } from "../src/mcp/live-room.js";
import { ViewObservationService } from "../src/notifications/view-observation.js";
import { Project } from "../src/schema/app-schema.js";

const UID = "owner";
const PROJECT = "kanban-production";
const context: KanbanObservationContextV1 = {
    version: 1,
    surface: "board",
    locale: "en-US",
    timeZone: "UTC",
};

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => resolve = done);
    return { promise, resolve };
}

async function seed(host: any, query: string, settings: Record<string, unknown> = {}) {
    const canonical = Project.createInstance("Kanban production");
    const tableDoc = new Y.Doc({ guid: `${PROJECT}--table--tasks` });
    tableDoc.getText("schema").insert(0, "CREATE TABLE tasks(id TEXT PRIMARY KEY, status TEXT, title TEXT)");
    for (
        const [id, values] of [["a", { status: "todo", title: "A" }], ["b", { status: "done", title: "B" }]] as const
    ) {
        const record = new Y.Map<unknown>();
        for (const [key, value] of Object.entries(values)) record.set(key, value);
        record.set("id", id);
        tableDoc.getMap<Y.Map<unknown>>("data").set(id, record);
    }
    const tableEntry = new Y.Map<unknown>();
    tableEntry.set("name", "Tasks");
    tableEntry.set("sqlName", "tasks");
    tableEntry.set("doc", tableDoc);
    canonical.ydoc.getMap("yjsTables").set("tasks", tableEntry);
    createKanbanEntry(canonical.ydoc as never, "board", {
        query,
        groupField: "status",
        laneOrder: ["done", "todo"],
        ...settings,
    });
    const project = await host.openDirectConnection(`projects/${PROJECT}`, { context: { uid: UID } });
    Y.applyUpdate(project.document as unknown as Y.Doc, Y.encodeStateAsUpdate(canonical.ydoc as never));
    const source = await host.openDirectConnection(`projects/${PROJECT}/tables/tasks`, { context: { uid: UID } });
    Y.applyUpdate(source.document as unknown as Y.Doc, Y.encodeStateAsUpdate(tableDoc));
    return [project, source];
}

describe("retained view observation production refresh", function() {
    this.timeout(30_000);
    let server: any;
    let stop: (server: unknown) => Promise<void>;

    beforeEach(async () => {
        const fixture = await import("./server-create-table-fixture.js");
        const acl = new fixture.AclStore();
        acl.grant("projectUsers", PROJECT, UID);
        server = await fixture.startTestServer(fixture.tempDir(), acl);
        stop = fixture.stopTestServer;
    });
    afterEach(async () => stop(server));

    it("refreshes an ordinary source edit on the same handle and retained rooms", async () => {
        const held = await seed(server.hocuspocus, "SELECT id, status, title FROM tasks ORDER BY id", {
            titleField: "title",
        });
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context,
        });
        const first = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(first.status).to.equal("ready");
        let invalidations = 0;
        handle.onInvalidate(() => invalidations++);
        const source = held[1].document as unknown as Y.Doc;
        source.getMap<Y.Map<unknown>>("data").get("a")!.set("title", "Changed");
        expect(invalidations).to.equal(1);
        const refreshed = await handle.readSnapshot({ observedAtUtcMs: 2 });
        expect(refreshed.status).to.equal("ready");
        if (refreshed.status !== "ready" || refreshed.projection.kind !== "kanban") throw new Error("not ready");
        expect(refreshed.projection.lanes.flatMap(lane => lane.cards.map(card => card.title))).to.include("Changed");
        expect(server.hocuspocus.documents.get(`projects/${PROJECT}/tables/tasks`)).to.equal(source);
        await handle.close();
        await Promise.all(held.map(connection => connection.disconnect()));
    });

    it("rejects a replacement that arrives during a held refresh", async () => {
        const held = await seed(server.hocuspocus, "SELECT id, status FROM tasks ORDER BY id");
        const reached = deferred();
        const resume = deferred();
        let openings = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, {
            beforeSourceOpen: async () => {
                if (++openings === 2) {
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context,
        });
        const source = held[1].document as unknown as Y.Doc;
        source.getMap("data").delete("a");
        const pending = handle.readSnapshot({ observedAtUtcMs: 2 });
        await reached.promise;
        const room = `projects/${PROJECT}/tables/tasks`;
        releaseWithoutStore(held[1]);
        server.hocuspocus.documents.delete(room);
        const replacement = await server.hocuspocus.openDirectConnection(room, { context: { uid: UID } });
        resume.resolve();
        expect(await pending).to.deep.equal({ status: "stale", reason: "incarnation_lost" });
        expect(await handle.readSnapshot({ observedAtUtcMs: 3 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
        await handle.close();
        await replacement.disconnect();
        await held[0].disconnect();
    });

    it("rejects a same-room saved definition replacement as incarnation_lost", async () => {
        const held = await seed(server.hocuspocus, "SELECT id, status, title FROM tasks ORDER BY id", {
            titleField: "title",
        });
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context,
        });
        expect((await handle.readSnapshot({ observedAtUtcMs: 1 })).status).to.equal("ready");
        const project = held[0].document as unknown as Y.Doc;
        project.getMap("yjsKanbans").delete("board");
        createKanbanEntry(project as never, "board", {
            query: "SELECT id, status, title FROM tasks ORDER BY id",
            groupField: "status",
            titleField: "title",
        });
        expect(await handle.readSnapshot({ observedAtUtcMs: 2 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
        expect(await handle.readSnapshot({ observedAtUtcMs: 3 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
        await handle.close();
        await Promise.all(held.map(connection => connection.disconnect()));
    });

    it("returns forbidden when access is revoked while a refresh opens its sources", async () => {
        const held = await seed(server.hocuspocus, "SELECT id, status FROM tasks ORDER BY id");
        const reached = deferred();
        const resume = deferred();
        let openings = 0;
        let accessible = true;
        const service = new ViewObservationService(server.hocuspocus, async () => accessible, {}, {
            beforeSourceOpen: async () => {
                if (++openings === 2) {
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context,
        });
        (held[1].document as unknown as Y.Doc).getMap("data").delete("a");
        const pending = handle.readSnapshot({ observedAtUtcMs: 2 });
        await reached.promise;
        accessible = false;
        resume.resolve();
        expect(await pending).to.deep.equal({ status: "forbidden", reason: "access_revoked" });
        await handle.close();
        await Promise.all(held.map(connection => connection.disconnect()));
    });

    it("releases an arriving refresh when the handle closes during source opening", async () => {
        const held = await seed(server.hocuspocus, "SELECT id, status FROM tasks ORDER BY id");
        const reached = deferred();
        const resume = deferred();
        let openings = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, {
            beforeSourceOpen: async () => {
                if (++openings === 2) {
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context,
        });
        let invalidations = 0;
        handle.onInvalidate(() => invalidations++);
        const source = held[1].document as unknown as Y.Doc;
        source.getMap("data").delete("a");
        const pending = handle.readSnapshot({ observedAtUtcMs: 2 });
        await reached.promise;
        const closing = handle.close();
        resume.resolve();
        expect(await pending).to.deep.equal({ status: "stale", reason: "closed" });
        await closing;
        const before = invalidations;
        source.getMap("data").set("after-close", new Y.Map());
        expect(invalidations).to.equal(before);
        await Promise.all(held.map(connection => connection.disconnect()));
    });
});
