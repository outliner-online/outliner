import { expect } from "chai";
import { RuntimeClock } from "./observation-runtime.clock.js";
import {
    deferred,
    edit,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./observation-runtime.fixture.js";

describe("notification runtime bounded debounce scheduling", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("schedules continuous edits by thirty seconds instead of restarting the quiet window forever", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture({ clock, quietMs: 5000, maxWaitMs: 30000, reconcileMs: 60000 });
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
        const initialReads = f.reads.length;
        const started = clock.now();
        edit(source, "B0");
        for (let index = 1; index <= 7; index++) {
            await clock.advance(4000);
            edit(source, `B${index}`);
            expect(f.reads).to.have.length(initialReads);
        }
        await clock.advance(1999);
        expect(f.reads).to.have.length(initialReads);
        await clock.advance(1);
        await waitFor(() => f.reads.length > initialReads, 15_000);
        expect(clock.now() - started).to.equal(30000);
        await waitFor(() => f.offered.length === 1);
        expect(JSON.stringify(f.offered[0].summary)).to.contain("B7");
    });

    it("keeps an invalidation arriving during a real capture dirty until a later current read", async () => {
        const clock = new RuntimeClock();
        const reached = deferred(), resume = deferred();
        let hold = false;
        f = await runtimeFixture({ clock, quietMs: 5000, maxWaitMs: 30000, reconcileMs: 60000 }, {
            beforeFinalCertification: async () => {
                if (!hold) return;
                hold = false;
                reached.resolve();
                await resume.promise;
            },
        });
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
        hold = true;
        edit(source, "B");
        await clock.advance(5000);
        await reached.promise;
        edit(source, "C");
        resume.resolve();
        await clock.until(() => f.offered.length === 1, 100);
        expect(JSON.stringify(f.offered[0].summary)).to.contain("C").and.not.contain("title: B;");
        expect(f.reads.some(read => read.result.status === "stale")).to.equal(true);
    });

    it("releases retained handles and every runtime timer after removal and shutdown", async () => {
        const clock = new RuntimeClock();
        f = await runtimeFixture({ clock });
        const { source } = await f.seed();
        const baselineListeners =
            (source as unknown as { _observers: Map<string, Set<unknown>>; })._observers.get("update")?.size ?? 0;
        f.runtime.start();
        await f.update([rule()]);
        await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
        const activeListeners =
            (source as unknown as { _observers: Map<string, Set<unknown>>; })._observers.get("update")?.size ?? 0;
        expect(activeListeners).to.be.greaterThan(baselineListeners);
        await f.update([], ["watch-grid"]);
        await clock.until(() => f.runtime.diagnostics().admissions === 0);
        expect((source as unknown as { _observers: Map<string, Set<unknown>>; })._observers.get("update")?.size ?? 0)
            .to.equal(baselineListeners);
        await f.runtime.close();
        expect(clock.pendingTimers).to.equal(0);
        const count = f.offered.length;
        edit(source, "After cleanup");
        await clock.advance(60000);
        expect(f.offered).to.have.length(count);
        expect(f.runtime.diagnostics()).to.include({ admissions: 0, evaluating: 0, candidates: 0, retainedBytes: 0 });
    });
});
