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
import { observedTransport, settleTransport } from "./observation-runtime.transport.js";

describe("notification runtime dispatch under evaluation pressure", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("keeps A after capacity rejects B before writing even when the adapter reports generic failure", async () => {
        const clock = new RuntimeClock();
        const reached = deferred(), resume = deferred();
        let hold = false;
        f = await runtimeFixture({
            clock,
            quietMs: 5000,
            maxWaitMs: 30000,
            reconcileMs: 60000,
            attemptTimeoutMs: 600000,
            limits: { maxConcurrentEvaluations: 1 },
        }, {
            beforeFinalCertification: async () => {
                if (!hold) return;
                hold = false;
                reached.resolve();
                await resume.promise;
            },
        });
        const first = await f.seed();
        const second = await f.seed("notification-second");
        const firstOffers = () => f.offered.filter(candidate => candidate.ruleId === "watch-grid");
        f.runtime.start();
        await f.update([rule(), rule("watch-second", "notification-second")]);
        await clock.until(() => f.runtime.status(UID).filter(status => status.state === "watching").length === 2);
        edit(first.source, "B");
        await clock.until(() => firstOffers().length === 1);
        const captured = firstOffers()[0];
        hold = true;
        edit(second.source, "Other rule changed");
        await clock.advance(5000);
        await reached.promise;
        try {
            expect(f.runtime.diagnostics().evaluating).to.equal(1);
            const transport = observedTransport();
            const result = await transport.dispatch(captured);
            expect(result).to.include({ kind: "rejected", reason: "authorization", writeInitiated: false });
            expect(transport.bodies).to.have.length(0);
            // The real transport reports only failed/no-write, so the runtime must remember capacity refusal.
            settleTransport(captured, result);
            edit(first.source, "C");
        } finally {
            resume.resolve();
        }
        await clock.until(() => firstOffers().length === 2 && f.runtime.diagnostics().evaluating === 0, 100);
        const next = firstOffers()[1];
        expect(next.eventId).not.to.equal(captured.eventId);
        expect(JSON.stringify(next.summary)).to.contain("C");
        edit(first.source, "A");
        expect(await next.revalidate()).to.include({ status: "cancelled", reason: "reverted" });
        next.settleAttempt({ initiated: false, outcome: "cancelled" });
        const reads = f.reads.length;
        await clock.advance(5000);
        await waitFor(() => f.reads.length > reads && f.runtime.diagnostics().evaluating === 0, 15_000);
        expect(firstOffers()).to.have.length(2);
    });
});
