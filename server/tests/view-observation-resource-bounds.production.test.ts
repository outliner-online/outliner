import { expect } from "chai";
import * as Y from "yjs";
import { getGridDefinitionTarget, setGridQuery } from "../../shared/src/services/gridDefinition.js";
import { createKanbanEntry, getKanbanRegistry } from "../../shared/src/services/kanbanDefinition.js";
import type { DirectConnection } from "../src/mcp/live-room.js";
import { type ViewObservationHandle, ViewObservationService } from "../src/notifications/view-observation.js";
import type { TestServer } from "./server-create-table-fixture.js";
import { seedGridObservationParity } from "./view-observation-grid-fixture.js";

const PROJECT = "observation-capacity";
const UID = "owner";
const context = { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" } as const;

describe("retained production observation resource bounds", function() {
    this.timeout(30_000);
    let server: TestServer;
    let held: DirectConnection[];
    let observations: ViewObservationHandle[];
    let stop: (server: TestServer) => Promise<void>;
    beforeEach(async () => {
        held = [];
        observations = [];
        const fixture = await import("./server-create-table-fixture.js");
        const acl = new fixture.AclStore();
        acl.grant("projectUsers", PROJECT, UID);
        server = await fixture.startTestServer(fixture.tempDir(), acl);
        stop = fixture.stopTestServer;
        held = await seedGridObservationParity(server.hocuspocus, PROJECT, UID);
    });
    afterEach(async () => {
        await Promise.all(observations.map(handle => handle.close()));
        await Promise.all(held.map(connection => connection.disconnect()));
        await stop(server);
    });

    it("refuses source over-capacity before opening Tables, and recovers on the retained project", async () => {
        const documents = held.map(connection => connection.document!);
        const original = documents.map(document => document.directConnectionsCount);
        let opened = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, {
            maxSourceRooms: 1,
            beforeSourceOpen: async () => {
                opened++;
            },
        });
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" },
            context,
        });
        observations.push(handle);
        expect(await handle.readSnapshot({ observedAtUtcMs: 1 }))
            .to.deep.equal({ status: "unavailable", reason: "resource_limit" });
        expect(opened).to.equal(0);
        expect(documents.map(document => document.directConnectionsCount))
            .to.deep.equal([original[0] + 1, original[1], original[2]]);
        const project = documents[0] as unknown as Y.Doc;
        project.getMap("yjsTables").delete("notes");
        setGridQuery(getGridDefinitionTarget(project as never, "heterogeneous")!, "SELECT observed_on FROM choices");
        expect((await handle.readSnapshot({ observedAtUtcMs: 2 })).status).to.equal("ready");
        expect(opened).to.equal(1);
        await handle.close();
        expect(documents.map(document => document.directConnectionsCount)).to.deep.equal(original);
    });

    it("bounds Kanban source captures and drops listeners for sources no longer used", async () => {
        const documents = held.map(connection => connection.document!);
        const original = documents.map(document => document.directConnectionsCount);
        const listeners = documents.map(updateListenerCount);
        const project = documents[0] as unknown as Y.Doc;
        const query = (table: string) => `SELECT id, 'todo'::text AS status, hidden AS title FROM ${table}`;
        createKanbanEntry(project as never, "board", {
            query: query("choices"),
            groupField: "status",
            titleField: "title",
        });
        const capped = new ViewObservationService(server.hocuspocus, async () => true, {}, { maxSourceRooms: 0 });
        const blocked = await capped.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context: { ...context, surface: "board" },
        });
        observations.push(blocked);
        expect(await blocked.readSnapshot({ observedAtUtcMs: 1 }))
            .to.deep.equal({ status: "unavailable", reason: "resource_limit" });
        expect(documents.map(document => document.directConnectionsCount))
            .to.deep.equal([original[0] + 1, original[1], original[2]]);
        await blocked.close();
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, { maxSourceRooms: 1 });
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
            context: { ...context, surface: "board" },
        });
        observations.push(handle);
        expect((await handle.readSnapshot({ observedAtUtcMs: 2 })).status).to.equal("ready");
        expect(updateListenerCount(documents[1])).to.equal(listeners[1] + 1);
        getKanbanRegistry(project).get("board")!.set("query", query("notes"));
        expect((await handle.readSnapshot({ observedAtUtcMs: 3 })).status).to.equal("ready");
        expect(documents.map(updateListenerCount)).to.deep.equal([listeners[0] + 1, listeners[1], listeners[2] + 1]);
        expect(documents.map(document => document.directConnectionsCount))
            .to.deep.equal([original[0] + 1, original[1], original[2] + 1]);
        let invalidations = 0;
        handle.onInvalidate(() => invalidations++);
        (documents[1] as unknown as Y.Doc).getMap<Y.Map<unknown>>("data").get("same")!.set("hidden", "unused");
        expect(invalidations).to.equal(0);
        await handle.close();
        expect(documents.map(updateListenerCount)).to.deep.equal(listeners);
        expect(documents.map(document => document.directConnectionsCount)).to.deep.equal(original);
    });
});

function updateListenerCount(document: unknown): number {
    return (document as { _observers: Map<string, Set<unknown>>; })._observers.get("update")?.size ?? 0;
}
