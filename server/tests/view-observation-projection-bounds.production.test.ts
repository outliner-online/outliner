import { expect } from "chai";
import sinon from "sinon";
import { KanbanProjectionObservation } from "../src/mcp/kanban-query-service.js";
import { retainedJsonBytes } from "../src/notifications/observation-memory.js";
import { type ViewObservationHandle, ViewObservationService } from "../src/notifications/view-observation.js";
import {
    calendarRule,
    edit,
    kanbanRule,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
} from "./notifications/observation-runtime.fixture.js";

describe("production retained projection budgets", function() {
    this.timeout(60_000);
    let f: RuntimeFixture;
    let handle: ViewObservationHandle | undefined;
    afterEach(async () => {
        sinon.restore();
        await handle?.close();
        handle = undefined;
        await f?.close();
    });

    for (
        const [kind, makeRule, budget] of [
            ["grid", rule, 2048],
            ["calendar", calendarRule, 16384],
            ["kanban", kanbanRule, 4096],
        ] as const
    ) {
        it(`refuses an oversized ${kind} projection at its retained producer and recovers on the same handle`, async () => {
            f = await runtimeFixture();
            const { source } = await f.seed();
            const watched = makeRule();
            const service = new ViewObservationService(f.server.hocuspocus, f.acl.checkAccess, {}, {
                maxProjectionBytes: budget,
            });
            edit(source, "😀".repeat(20_000));
            handle = await service.openViewObservation({ uid: UID, target: watched.target, context: watched.context });
            expect(await handle.readSnapshot({ observedAtUtcMs: 1 }))
                .to.deep.equal({ status: "unavailable", reason: "resource_limit" });
            edit(source, "A");
            const recovered = await handle.readSnapshot({ observedAtUtcMs: 2 });
            expect(recovered.status).to.equal("ready");
            if (recovered.status !== "ready") throw new Error("Expected bounded current projection");
            expect(retainedJsonBytes(recovered.projection)).to.be.at.most(budget);
            expect(handle.isCurrent(recovered.versionToken)).to.equal(true);
        });
    }

    it("uses the lower per-admission budget even when its observation service permits a larger capture", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        edit(source, "X".repeat(1000));
        const watched = rule();
        const service = new ViewObservationService(f.server.hocuspocus, f.acl.checkAccess, {}, {
            maxProjectionBytes: 8192,
        });
        handle = await service.openViewObservation({
            uid: UID,
            target: watched.target,
            context: watched.context,
            maxProjectionBytes: 2048,
        });
        expect(await handle.readSnapshot({ observedAtUtcMs: 1 }))
            .to.deep.equal({ status: "unavailable", reason: "resource_limit" });
        await handle.close();
        handle = await service.openViewObservation({
            uid: UID,
            target: watched.target,
            context: watched.context,
            maxProjectionBytes: 8192,
        });
        const permitted = await handle.readSnapshot({ observedAtUtcMs: 2 });
        expect(permitted.status).to.equal("ready");
    });

    it("drops actual Kanban diagnostic rows after deriving the visible projection, preserving live currency", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        edit(source, "hidden-sentinel".repeat(10_000), "a", "hidden");
        // Observe the real production result-release boundary; the spy neither
        // replaces its behavior nor supplies projection/currentness evidence.
        const releases = sinon.spy(KanbanProjectionObservation.prototype, "releaseResult");
        const watched = kanbanRule();
        const service = new ViewObservationService(f.server.hocuspocus, f.acl.checkAccess, {}, {
            maxProjectionBytes: 4096,
        });
        handle = await service.openViewObservation({ uid: UID, target: watched.target, context: watched.context });
        const ready = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(ready.status).to.equal("ready");
        expect(releases.callCount).to.equal(1);
        const retained = releases.firstCall.thisValue as KanbanProjectionObservation;
        expect(retained.lanes).to.have.length(0);
        expect(retained.columns).to.have.length(0);
        expect(retained.routes).to.have.length(0);
        expect(retained.settings).to.equal(undefined);
        expect(retained.isCurrent()).to.equal(true);
        expect(JSON.stringify(ready)).not.to.contain("hidden-sentinel");
        if (ready.status !== "ready") throw new Error("Expected a bounded Kanban projection");
        expect(handle.isCurrent(ready.versionToken)).to.equal(true);
        edit(source, "Changed title");
        expect(handle.isCurrent(ready.versionToken)).to.equal(false);
        const changed = await handle.readSnapshot({ observedAtUtcMs: 2 });
        expect(changed.status).to.equal("ready");
        expect(JSON.stringify(changed)).to.contain("Changed title");
        expect(releases.callCount).to.equal(2);
    });
});
