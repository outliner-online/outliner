import { expect } from "chai";
import * as Y from "yjs";
import type { GridObservationContextV1 } from "../../shared/src/notifications/gridProjection.js";
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
});

function revision(doc: Y.Doc): string {
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64url");
}
