import { expect } from "chai";
import { RuntimeClock } from "./observation-runtime.clock.js";
import { edit, rule, type RuntimeFixture, runtimeFixture, UID, waitFor } from "./observation-runtime.fixture.js";

describe("notification runtime debounce while an adapter retains its candidate", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    for (const initiated of [false, true]) {
        it(`evaluates by thirty seconds before pending B settles with initiated=${initiated}`, async () => {
            const clock = new RuntimeClock();
            f = await runtimeFixture({
                clock,
                quietMs: 5000,
                maxWaitMs: 30000,
                reconcileMs: 60000,
                attemptTimeoutMs: 600000,
            });
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([rule()]);
            await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
            edit(source, "B");
            await clock.until(() => f.offered.length === 1);
            const captured = f.offered[0];
            const initialReads = f.reads.length;
            const started = clock.now();
            edit(source, "C0");
            for (let index = 1; index <= 7; index++) {
                await clock.advance(4000);
                edit(source, `C${index}`);
                expect(f.reads).to.have.length(initialReads);
            }
            await clock.advance(1999);
            expect(f.reads).to.have.length(initialReads);
            await clock.advance(1);
            await waitFor(() => f.reads.length > initialReads && f.runtime.diagnostics().evaluating === 0, 15_000);
            expect(clock.now() - started).to.equal(30000);
            expect(f.offered).to.have.length(1);
            expect(await captured.revalidate()).to.include({ status: "deferred", reason: "superseded" });
            // A superseded pending payload cannot suppress observation or create a second in-flight candidate.
            captured.settleAttempt({ initiated, outcome: "failed" });
            await clock.until(() => f.offered.length === 2 && f.runtime.diagnostics().evaluating === 0);
            const next = f.offered[1];
            expect(next.eventId).not.to.equal(captured.eventId);
            expect(JSON.stringify(next.summary)).to.contain("C7");
            // Only a proven first write makes B the next baseline; a no-write refusal retains A.
            edit(source, initiated ? "B" : "A");
            expect(await next.revalidate()).to.include({ status: "cancelled", reason: "reverted" });
            next.settleAttempt({ initiated: false, outcome: "cancelled" });
            const reads = f.reads.length;
            await clock.advance(5000);
            await waitFor(() => f.reads.length > reads && f.runtime.diagnostics().evaluating === 0, 15_000);
            expect(f.offered).to.have.length(2);
        });
    }
});
