import { expect } from "chai";
import { NotificationObservationRuntime } from "../../src/notifications/observation-runtime.js";
import type { PreparedViewChange } from "../../src/notifications/prepared-view-change.js";
import { RuntimeClock } from "./observation-runtime.clock.js";
import { deferred, edit, rule, type RuntimeFixture, runtimeFixture, UID } from "./observation-runtime.fixture.js";

const watching = (f: RuntimeFixture, ruleId: string) =>
    f.runtime.status(UID).some(status =>
        status.ruleId === ruleId && status.channel === "mcp"
        && status.state === "watching"
    );

describe("notification runtime retained ownership limits", function() {
    this.timeout(60_000);
    let f: RuntimeFixture;
    let independent: NotificationObservationRuntime | undefined;
    afterEach(async () => {
        await independent?.close();
        independent = undefined;
        await f?.close();
    });

    it("rotates an expired same-owner admission without repeatedly readmitting the earlier rule", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture({
            clock,
            admissionLeaseMs: 1000,
            reconcileMs: 100,
            limits: { maxAdmissions: 2, maxPerOwner: 1, discoveryPageSize: 1 },
        });
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule("a-first")]);
        await clock.until(() => watching(f, "a-first"));
        await f.update([rule("b-late")]);
        edit(source, "Before late admission");
        await clock.advance(2000);
        await clock.until(() => watching(f, "b-late"));
        expect(f.runtime.diagnostics().admissions).to.be.at.most(2);
        expect(f.offered.filter(candidate => candidate.ruleId === "b-late")).to.have.length(0);
        edit(source, "After late admission");
        await clock.until(() => f.offered.some(candidate => candidate.ruleId === "b-late"));
        const late = f.offered.find(candidate => candidate.ruleId === "b-late")!;
        expect(JSON.stringify(late.summary)).to.contain("After late admission");
        expect(f.offered.filter(candidate => candidate.ruleId === "b-late")).to.have.length(1);
    });

    it("keeps a retired admission charged while its unsettled candidate retains that owner", async () => {
        const clock = new RuntimeClock();
        const maxRetainedBytes = 32 * 1024;
        f = await runtimeFixture({
            clock,
            reconcileMs: 100,
            limits: { maxAdmissions: 1, maxRetainedBytes, maxProjectionBytes: 4096, maxPendingAttempts: 4 },
        });
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => watching(f, "watch-grid"));
        edit(source, "B");
        await clock.until(() => f.offered.length === 1);
        const captured = f.offered[0];
        f.runtime.reclaim(UID, "watch-grid");
        await clock.advance(500);
        expect((await captured.revalidate()).status).to.equal("cancelled");
        expect(f.runtime.status(UID).find(status => status.channel === "mcp")).to.include({
            state: "blocked",
            reason: "capacity_deferred",
        });
        expect(f.runtime.diagnostics().candidates).to.equal(1);
        expect(f.runtime.diagnostics().retainedBytes).to.be.at.most(maxRetainedBytes);
        captured.settleAttempt({ initiated: false, outcome: "cancelled" });
        await clock.until(() => watching(f, "watch-grid"));
        expect(f.offered).to.have.length(1);
        edit(source, "C");
        await clock.until(() => f.offered.length === 2);
        expect(f.offered[1].eventId).not.to.equal(captured.eventId);
    });

    it("charges an unsettled callback after settlement until the callback actually releases it", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture();
        const { source } = await f.seed();
        independent = new NotificationObservationRuntime(f.server.notificationSettings, f.observations,
            f.acl.checkAccess, {
            clock,
            quietMs: 5,
            reconcileMs: 50,
            limits: { maxPendingAttempts: 1 },
        });
        const reached = deferred(), resume = deferred();
        const offered: PreparedViewChange[] = [];
        independent.subscribe("mcp", async candidate => {
            offered.push(candidate);
            candidate.settleAttempt({ initiated: false, outcome: "no_destination" });
            if (offered.length === 1) {
                reached.resolve();
                await resume.promise;
            }
        });
        independent.start();
        await f.update([rule()]);
        await clock.until(() => independent!.status(UID).some(status => status.state === "watching"));
        edit(source, "B");
        await clock.until(() => offered.length === 1);
        await reached.promise;
        try {
            edit(source, "C");
            await clock.advance(500);
            expect(independent.diagnostics().candidates).to.equal(1);
            expect(offered).to.have.length(1);
        } finally {
            resume.resolve();
        }
        await clock.until(() => offered.length === 2);
        expect(JSON.stringify(offered[1].summary)).to.contain("C");
        expect(independent.diagnostics().candidates).to.be.at.most(1);
    });
});
