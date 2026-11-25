import { expect } from "chai";
import * as Y from "yjs";
import type { KanbanObservationContextV1 } from "../../shared/src/notifications/kanbanProjection.js";
import { createKanbanEntry, getKanbanRegistry } from "../../shared/src/services/kanbanDefinition.js";
import { OutlinerKanbanQueryService } from "../src/mcp/kanban-query-service.js";
import { type DirectConnection, releaseWithoutStore } from "../src/mcp/live-room.js";
import { type ViewObservationHandle, ViewObservationService } from "../src/notifications/view-observation.js";
import { Project } from "../src/schema/app-schema.js";
import type { TestServer } from "./server-create-table-fixture.js";

const UID = "owner";
const PROJECT = "kanban-initial";
const QUERY = "SELECT id, status, title FROM tasks";
const OVERFLOW = "SELECT status, title FROM tasks CROSS JOIN generate_series(1, 10001)";
const context: KanbanObservationContextV1 = { version: 1, surface: "board", locale: "en-US", timeZone: "UTC" };

describe("initial non-ready Kanban observation ownership", function() {
    this.timeout(30_000);
    let server: TestServer;
    let held: DirectConnection[];
    let observations: ViewObservationHandle[];
    let stop: (server: TestServer) => Promise<void>;

    beforeEach(async () => {
        const fixture = await import("./server-create-table-fixture.js");
        const acl = new fixture.AclStore();
        acl.grant("projectUsers", PROJECT, UID);
        server = await fixture.startTestServer(fixture.tempDir(), acl);
        stop = fixture.stopTestServer;
        held = [];
        observations = [];
    });
    afterEach(async () => {
        await Promise.all(observations.map(handle => handle.close()));
        await Promise.all(held.map(connection => connection.disconnect()));
        await stop(server);
    });

    async function seed(query: string, groupField = "status") {
        const canonical = Project.createInstance("Initial Kanban");
        const source = new Y.Doc();
        source.getText("schema").insert(0, "CREATE TABLE tasks(id TEXT PRIMARY KEY, status TEXT, title TEXT)");
        const record = new Y.Map<unknown>();
        for (const [key, value] of Object.entries({ id: "a", status: "todo", title: "A" })) record.set(key, value);
        source.getMap("data").set("a", record);
        const table = new Y.Map<unknown>();
        table.set("sqlName", "tasks");
        table.set("doc", source);
        canonical.ydoc.getMap("yjsTables").set("tasks", table);
        createKanbanEntry(canonical.ydoc as never, "board", { query, groupField, titleField: "title" });
        const project = await server.hocuspocus.openDirectConnection(`projects/${PROJECT}`, { context: { uid: UID } });
        Y.applyUpdate(project.document as unknown as Y.Doc, Y.encodeStateAsUpdate(canonical.ydoc as never));
        const tableRoom = await server.hocuspocus.openDirectConnection(`projects/${PROJECT}/tables/tasks`, {
            context: { uid: UID },
        });
        Y.applyUpdate(tableRoom.document as unknown as Y.Doc, Y.encodeStateAsUpdate(source));
        held.push(project, tableRoom);
        return getKanbanRegistry(project.document as unknown as Y.Doc).get("board")!;
    }

    async function open(service = new ViewObservationService(server.hocuspocus, async () => true)) {
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context,
        });
        observations.push(handle);
        return handle;
    }

    for (const scenario of [
        { name: "invalid query", query: "DELETE FROM tasks", status: "unavailable", reason: "invalid_query" },
        { name: "missing role", query: QUERY, group: "", status: "incomplete", reason: "missing_role" },
        {
            name: "missing source",
            query: "SELECT id, status, title FROM absent_source",
            status: "unavailable",
            reason: "missing_source",
        },
        { name: "resource limit", query: OVERFLOW, status: "unavailable", reason: "resource_limit" },
    ]) {
        it(`retains and recovers from an initial ${scenario.name}, then releases on close`, async () => {
            const definition = await seed(scenario.query, scenario.group);
            const documents = held.map(connection => connection.document!);
            const baseline = documents.map(document => document.getConnectionsCount());
            const handle = await open();
            expect(await handle.readSnapshot({ observedAtUtcMs: 1 })).to.deep.equal({
                status: scenario.status,
                reason: scenario.reason,
            });
            let invalidations = 0;
            handle.onInvalidate(() => invalidations++);
            definition.set("query", QUERY);
            definition.set("groupField", "status");
            expect(invalidations).to.be.greaterThan(0);
            const recovered = await handle.readSnapshot({ observedAtUtcMs: 2 });
            expect(recovered.status).to.equal("ready");
            if (recovered.status !== "ready" || recovered.projection.kind !== "kanban") throw new Error("not ready");
            expect(recovered.projection.lanes.flatMap(lane => lane.cards.map(card => card.title))).to.deep.equal(["A"]);
            expect(handle.isCurrent(recovered.versionToken)).to.equal(true);
            await handle.close();
            await handle.close();
            expect(handle.isCurrent(recovered.versionToken)).to.equal(false);
            expect(documents.map(document => document.getConnectionsCount())).to.deep.equal(baseline);
            const before = invalidations;
            definition.set("name", "After close");
            expect(invalidations).to.equal(before);
        });
    }

    it("retains source incarnation after an initial resource refusal", async () => {
        const definition = await seed(OVERFLOW);
        const handle = await open();
        expect(await handle.readSnapshot({ observedAtUtcMs: 1 })).to.deep.equal({
            status: "unavailable",
            reason: "resource_limit",
        });
        const room = `projects/${PROJECT}/tables/tasks`;
        releaseWithoutStore(held[1]);
        server.hocuspocus.documents.delete(room);
        held.push(await server.hocuspocus.openDirectConnection(room, { context: { uid: UID } }));
        definition.set("query", QUERY);
        expect(await handle.readSnapshot({ observedAtUtcMs: 2 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
        expect(await handle.readSnapshot({ observedAtUtcMs: 3 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
    });

    it("keeps ordinary diagnostic non-ready captures eagerly released", async () => {
        await seed(OVERFLOW);
        const documents = held.map(connection => connection.document!);
        const baseline = documents.map(document => document.getConnectionsCount());
        const service = new OutlinerKanbanQueryService(server.hocuspocus, async () => true);
        const observed = await service.openObservation(UID, PROJECT, "board");
        expect(observed).to.include({ status: "unavailable", reason: "resource_limit" });
        expect(documents.map(document => document.getConnectionsCount())).to.deep.equal(baseline);
        await observed.release();
        expect(documents.map(document => document.getConnectionsCount())).to.deep.equal(baseline);
    });

    it("releases a failed initial capture when its final ACL check rejects access", async () => {
        await seed("DELETE FROM tasks");
        const documents = held.map(connection => connection.document!);
        const baseline = documents.map(document => document.getConnectionsCount());
        let checks = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => ++checks < 4);
        let failure: unknown;
        try {
            await open(service);
        } catch (error) {
            failure = error;
        }
        expect(failure).to.have.property("code", "forbidden");
        expect(documents.map(document => document.getConnectionsCount())).to.deep.equal(baseline);
    });
});
