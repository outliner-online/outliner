import { expect } from "chai";
import { edit, rule, type RuntimeFixture, runtimeFixture, waitFor } from "./observation-runtime.fixture.js";
import { observedTransport, settleTransport } from "./observation-runtime.transport.js";

describe("notification runtime concurrent destination preparation", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("certifies two concurrent destinations for the same exact candidate without invalidating either", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([{ ...rule(), channels: { mcp: false, mobile: true } }]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.offered.length === 1, 15_000);
        const candidate = f.offered[0];
        const first = observedTransport();
        const second = observedTransport();
        const outcomes = await Promise.all([first.dispatch(candidate), second.dispatch(candidate)]);
        expect(outcomes.map(result => result.writeInitiated)).to.deep.equal([true, true]);
        expect(first.bodies).to.have.length(1);
        expect(second.bodies).to.have.length(1);
        expect(first.bodies[0].equals(second.bodies[0])).to.equal(true);
        expect(JSON.parse(first.bodies[0].toString()).eventId).to.equal(candidate.eventId);
        settleTransport(candidate, outcomes[0]);
        await f.evaluated(() => edit(source, "B"));
        expect(f.offered).to.have.length(1);
    });
});
