import { expect } from "chai";
import { RuntimeClock } from "./observation-runtime.clock.js";
import { deferred, edit, rule, type RuntimeFixture, runtimeFixture, UID } from "./observation-runtime.fixture.js";
import { observedTransport, settleTransport } from "./observation-runtime.transport.js";

describe("notification runtime terminal opportunity expiry", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    for (const outcome of ["failed", "expired"] as const) {
        it(`consumes source-current B once after ${outcome} without allowing an expired body write`, async () => {
            const clock = new RuntimeClock();
            f = await runtimeFixture({ clock, reconcileMs: 60000, attemptTimeoutMs: 1000 });
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([rule()]);
            await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
            edit(source, "B");
            await clock.until(() => f.offered.length === 1);
            const captured = f.offered[0];
            const reached = deferred(), resume = deferred();
            const hold = async () => {
                reached.resolve();
                await resume.promise;
            };
            // Exercise expiry before revalidation and after certification but before the first write.
            const transport = observedTransport(outcome === "failed"
                ? { beforeRevalidate: hold }
                : { afterRevalidate: hold });
            const sending = transport.dispatch(captured);
            await reached.promise;
            try {
                await clock.advance(1001);
                expect(f.offered).to.have.length(1);
                expect(transport.bodies).to.have.length(0);
            } finally {
                resume.resolve();
            }
            const result = await sending;
            expect(result).to.include({ kind: "rejected", reason: "authorization", writeInitiated: false });
            expect(transport.bodies).to.have.length(0);
            expect(await captured.revalidate()).to.include({ status: "cancelled", reason: "expired" });
            const reads = f.reads.length;
            if (outcome === "failed") settleTransport(captured, result);
            else captured.settleAttempt({ initiated: result.writeInitiated, outcome });
            await clock.until(() => f.reads.length > reads && f.runtime.diagnostics().evaluating === 0);
            expect(f.offered).to.have.length(1);
            edit(source, "C");
            await clock.until(() => f.offered.length === 2 && f.runtime.diagnostics().evaluating === 0);
            const next = f.offered[1];
            expect(next.eventId).not.to.equal(captured.eventId);
            expect(JSON.stringify(next.summary)).to.contain("C");
            // Returning to B proves terminal expiry consumed B rather than retaining the old A baseline.
            edit(source, "B");
            expect(await next.revalidate()).to.include({ status: "cancelled", reason: "reverted" });
            next.settleAttempt({ initiated: false, outcome: "cancelled" });
            const laterReads = f.reads.length;
            await clock.until(() => f.reads.length > laterReads && f.runtime.diagnostics().evaluating === 0);
            expect(f.offered).to.have.length(2);
        });
    }
});
