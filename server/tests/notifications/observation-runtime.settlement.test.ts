import { expect } from "chai";
import { edit, rule, type RuntimeFixture, runtimeFixture, waitFor } from "./observation-runtime.fixture.js";

describe("notification runtime zero-initiation settlement", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    for (const outcome of ["no_destination", "failed"] as const) {
        it(`skips a still-current ${outcome} once and compares later work from that baseline`, async () => {
            f = await runtimeFixture();
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([rule()]);
            await f.watching(["watch-grid"]);
            edit(source, "B");
            await waitFor(() => f.offered.length === 1, 15_000);
            const captured = f.offered[0];
            captured.settleAttempt({ initiated: false, outcome });
            captured.settleAttempt({ initiated: false, outcome });
            await f.evaluated(() => edit(source, "B"));
            expect(f.offered).to.have.length(1);
            edit(source, "C");
            await waitFor(() => f.offered.length === 2, 15_000);
            edit(source, "B");
            expect((await f.offered[1].revalidate()).status).not.to.equal("current");
            f.offered[1].settleAttempt({ initiated: false, outcome: "cancelled" });
            await f.evaluated(() => edit(source, "B"));
            expect(f.offered).to.have.length(2);
        });
    }

    it("does not skip stale B when C precedes its terminal zero-initiation settlement", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.offered.length === 1, 15_000);
        const captured = f.offered[0];
        edit(source, "C");
        captured.settleAttempt({ initiated: false, outcome: "no_destination" });
        await waitFor(() => f.offered.length === 2, 15_000);
        // C is A-to-C: reversion to A cancels it. Advancing stale B would incorrectly emit B-to-A.
        edit(source, "A");
        expect((await f.offered[1].revalidate()).status).not.to.equal("current");
        f.offered[1].settleAttempt({ initiated: false, outcome: "cancelled" });
        await f.evaluated(() => edit(source, "A"));
        expect(f.offered).to.have.length(2);
    });
});
