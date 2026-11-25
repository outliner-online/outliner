import { expect } from "chai";
import { RuntimeClock } from "./observation-runtime.clock.js";
import {
    deferred,
    edit,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
} from "./observation-runtime.fixture.js";

const watching = (f: RuntimeFixture, owner: string, ruleId: string) =>
    f.runtime.status(owner)
        .some(status => status.ruleId === ruleId && status.state === "watching");

describe("notification runtime process-wide resource pressure", function() {
    this.timeout(60_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("bounds admission across owners and admits a deferred late owner when capacity is released", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture({
            clock,
            reconcileMs: 100,
            limits: { maxAdmissions: 2, maxPerOwner: 1, discoveryPageSize: 1 },
        });
        await f.seed();
        await f.seed("notification-second", "owner-second");
        const late = await f.seed("notification-late", "owner-late");
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => watching(f, UID, "watch-grid"));
        await f.update([rule("watch-second", "notification-second")], [], "owner-second");
        await clock.until(() => watching(f, "owner-second", "watch-second"));
        await f.update([rule("watch-late", "notification-late")], [], "owner-late");
        edit(late.source, "Before admission");
        await clock.advance(500);
        expect(f.runtime.diagnostics().admissions).to.equal(2);
        expect(
            f.runtime.status("owner-late").some(status => status.state === "blocked"),
        )
            .to.equal(true);
        expect(f.offered).to.have.length(0);
        await f.update([], ["watch-grid"]);
        await clock.until(() => watching(f, "owner-late", "watch-late"), 20);
        expect(f.runtime.diagnostics().admissions).to.be.at.most(2);
        expect(f.offered).to.have.length(0);
        edit(late.source, "After admission");
        await clock.until(() => f.offered.length === 1);
        expect(f.offered[0].target.projectId).to.equal("notification-late");
        expect(JSON.stringify(f.offered[0].summary)).to.contain("After admission");
    });

    it("retains dirty work and its settled baseline when an evaluation slot is occupied", async () => {
        const clock = new RuntimeClock();
        const reached = deferred(), resume = deferred();
        let hold = false;
        f = await runtimeFixture({
            clock,
            quietMs: 5000,
            maxWaitMs: 30000,
            reconcileMs: 1000,
            limits: { maxAdmissions: 2, maxConcurrentEvaluations: 1 },
        }, {
            beforeFinalCertification: async () => {
                if (!hold) return;
                hold = false;
                reached.resolve();
                await resume.promise;
            },
        });
        const first = await f.seed();
        const second = await f.seed("notification-second", "owner-second");
        f.runtime.start();
        await f.update([rule()]);
        await f.update([rule("watch-second", "notification-second")], [], "owner-second");
        await clock.until(() => watching(f, UID, "watch-grid") && watching(f, "owner-second", "watch-second"));
        hold = true;
        edit(first.source, "First changed");
        await clock.advance(5000);
        await reached.promise;
        try {
            edit(second.source, "Second changed");
            await clock.advance(30000);
            expect(f.runtime.diagnostics().evaluating).to.equal(1);
            const deferredStatus = f.runtime.status("owner-second").find(status => status.channel === "mcp")!;
            expect(deferredStatus.state).to.equal("blocked");
            expect(JSON.stringify(deferredStatus)).to.contain("capacity");
            expect(f.offered).to.have.length(0);
        } finally {
            resume.resolve();
        }
        await clock.until(() => f.offered.length === 2, 100);
        expect(f.runtime.diagnostics().evaluating).to.be.at.most(1);
        const retained = f.offered.find(candidate => candidate.ruleId === "watch-second")!;
        expect(JSON.stringify(retained.summary)).to.contain("Second changed");
        edit(second.source, "A");
        expect((await retained.revalidate()).status).not.to.equal("current");
        retained.settleAttempt({ initiated: false, outcome: "cancelled" });
        await clock.advance(30000);
        expect(f.offered.filter(candidate => candidate.ruleId === "watch-second")).to.have.length(1);
    });

    it("reclaims a generation explicitly, fences its candidate and silently baselines readmission", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture({ clock, reconcileMs: 100, limits: { maxAdmissions: 1 } });
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => watching(f, UID, "watch-grid"));
        edit(source, "B");
        await clock.until(() => f.offered.length === 1);
        const old = f.offered[0];
        f.runtime.reclaim(UID, "watch-grid");
        edit(source, "C");
        expect((await old.revalidate()).status).not.to.equal("current");
        old.settleAttempt({ initiated: true, outcome: "unknown" });
        await clock.until(() => watching(f, UID, "watch-grid"), 20);
        expect(f.offered).to.have.length(1);
        edit(source, "D");
        await clock.until(() => f.offered.length === 2);
        expect(f.offered[1].eventId).not.to.equal(old.eventId);
        expect(f.offered[1].target.projectId).to.equal(PROJECT);
        edit(source, "C");
        expect((await f.offered[1].revalidate()).status).not.to.equal("current");
        f.offered[1].settleAttempt({ initiated: false, outcome: "cancelled" });
        await clock.advance(500);
        expect(f.offered).to.have.length(2);
    });

    it("refuses oversized retained projections without treating them as empty output", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture({ clock, limits: { maxProjectionBytes: 4096, maxRetainedBytes: 65536 } });
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => watching(f, UID, "watch-grid"));
        edit(source, "X".repeat(5000));
        await clock.until(() => f.runtime.status(UID).some(status => status.state === "blocked"));
        expect(f.runtime.diagnostics().retainedBytes).to.be.at.most(65536);
        expect(f.runtime.diagnostics().candidates).to.equal(0);
        expect(f.offered).to.have.length(0);
        edit(source, "A");
        await clock.until(() => watching(f, UID, "watch-grid"));
        expect(f.offered).to.have.length(0);
        edit(source, "B");
        await clock.until(() => f.offered.length === 1);
        expect(JSON.stringify(f.offered[0].summary)).to.contain("B");
    });
});
