import { expect } from "chai";
import * as Y from "yjs";
import type { GridObservationContextV1 } from "../../shared/src/notifications/gridProjection.js";
import { type DirectConnection, releaseWithoutStore } from "../src/mcp/live-room.js";
import { type ViewObservationHandle, ViewObservationService } from "../src/notifications/view-observation.js";
import type { AclStore, TestServer } from "./server-create-table-fixture.js";
import { seedGridObservationParity } from "./view-observation-grid-fixture.js";

const UID = "owner";
const PROJECT = "view-final-certification";
const context: GridObservationContextV1 = { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" };
const target = { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" } as const;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => resolve = done);
    return { promise, resolve };
}

describe("saved view final certification continuity", function() {
    this.timeout(30_000);
    let server: TestServer;
    let acl: AclStore;
    let held: DirectConnection[];
    let stop: (server: TestServer) => Promise<void>;
    let handles: ViewObservationHandle[];

    beforeEach(async () => {
        const fixture = await import("./server-create-table-fixture.js");
        acl = new fixture.AclStore();
        acl.grant("projectUsers", PROJECT, UID);
        server = await fixture.startTestServer(fixture.tempDir(), acl);
        stop = fixture.stopTestServer;
        held = await seedGridObservationParity(server.hocuspocus, PROJECT, UID);
        handles = [];
    });

    afterEach(async () => {
        await Promise.all(handles.map(handle => handle.close()));
        await Promise.all(held.map(connection => connection.disconnect()));
        await stop(server);
    });

    for (const change of ["replacement", "content edit"] as const) {
        it(`classifies a source ${change} after query execution at the first completed read`, async () => {
            const reached = deferred();
            const resume = deferred();
            let holdNext = false;
            const service = new ViewObservationService(server.hocuspocus, acl.checkAccess, {}, {
                beforeFinalCertification: async () => {
                    if (!holdNext) return;
                    holdNext = false;
                    reached.resolve();
                    await resume.promise;
                },
            });
            const handle = await service.openViewObservation({ uid: UID, target, context });
            handles.push(handle);
            const first = await handle.readSnapshot({ observedAtUtcMs: 1 });
            expect(first.status).to.equal("ready");
            if (first.status !== "ready") throw new Error("Grid not ready");
            expect(handle.isCurrent(first.versionToken)).to.equal(true);

            const source = held[1].document as unknown as Y.Doc;
            source.getMap<Y.Map<unknown>>("data").get("same")!.set("observed_on", "2026-11-25");
            holdNext = true;
            const pending = handle.readSnapshot({ observedAtUtcMs: 2 });
            await reached.promise;
            try {
                if (change === "replacement") {
                    // Preserve every value while replacing the live authority:
                    // both retained and candidate captures hold the displaced room.
                    const update = Y.encodeStateAsUpdate(source);
                    const room = `projects/${PROJECT}/tables/choices`;
                    releaseWithoutStore(held[1]);
                    server.hocuspocus.documents.delete(room);
                    const replacement = await server.hocuspocus.openDirectConnection(room, { context: { uid: UID } });
                    Y.applyUpdate(replacement.document as unknown as Y.Doc, update);
                    held[1] = replacement as unknown as DirectConnection;
                } else {
                    source.getMap<Y.Map<unknown>>("data").get("same")!.set("observed_on", "2026-11-26");
                }
            } finally {
                resume.resolve();
            }
            expect(await pending).to.deep.equal({
                status: "stale",
                reason: change === "replacement" ? "incarnation_lost" : "inputs_changed",
            });
            expect(handle.isCurrent(first.versionToken)).to.equal(false);

            const next = await handle.readSnapshot({ observedAtUtcMs: 3 });
            if (change === "replacement") {
                expect(next).to.deep.equal({ status: "stale", reason: "incarnation_lost" });
                await handle.close();
                const reopened = await service.openViewObservation({ uid: UID, target, context });
                handles.push(reopened);
                expect((await reopened.readSnapshot({ observedAtUtcMs: 4 })).status).to.equal("ready");
            } else {
                expect(next.status).to.equal("ready");
                if (next.status !== "ready" || next.projection.kind !== "grid") throw new Error("Grid not ready");
                expect(next.projection.rows[0]).to.deep.equal([{ value: "2026-11-26" }]);
            }
        });
    }
});
