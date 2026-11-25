import { expect } from "chai";
import { deferred, edit, rule, type RuntimeFixture, runtimeFixture, waitFor } from "./observation-runtime.fixture.js";
import { observedTransport, settleTransport } from "./observation-runtime.transport.js";

describe("notification runtime captured-payload dispatch races", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    for (const replacement of ["A", "C"]) {
        it(`rejects captured B after returning to ${replacement} at the actual pre-send boundary`, async () => {
            f = await runtimeFixture();
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([rule()]);
            await f.watching(["watch-grid"]);
            edit(source, "B");
            await waitFor(() => f.offered.length === 1, 15_000);
            const captured = f.offered[0];
            const reached = deferred(), resume = deferred();
            const transport = observedTransport({
                beforeRevalidate: async () => {
                    reached.resolve();
                    await resume.promise;
                },
            });
            const sending = transport.dispatch(captured);
            await reached.promise;
            edit(source, replacement);
            resume.resolve();
            const result = await sending;
            expect(result.writeInitiated).to.equal(false);
            expect(transport.bodies).to.have.length(0);
            settleTransport(captured, result);
            expect((await captured.revalidate()).status).not.to.equal("current");
            if (replacement === "A") {
                await f.evaluated(() => edit(source, "A"));
                expect(f.offered).to.have.length(1);
                edit(source, "C");
            }
            await waitFor(() => f.offered.length === 2, 15_000);
            const next = f.offered[1];
            expect(next.eventId).not.to.equal(captured.eventId);
            expect(JSON.stringify(next.summary)).to.contain("C");
            const currentTransport = observedTransport();
            const current = await currentTransport.dispatch(next);
            expect(current.writeInitiated).to.equal(true);
            expect(currentTransport.bodies).to.have.length(1);
            expect(JSON.parse(currentTransport.bodies[0].toString()).eventId).to.equal(next.eventId);
            settleTransport(next, current);
        });
    }

    for (const replacement of ["A", "C"]) {
        it(`checks source currency again after asynchronous preparation before the first write (${replacement})`, async () => {
            f = await runtimeFixture();
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([rule()]);
            await f.watching(["watch-grid"]);
            edit(source, "B");
            await waitFor(() => f.offered.length === 1, 15_000);
            const captured = f.offered[0];
            const reached = deferred(), resume = deferred();
            const transport = observedTransport({
                afterRevalidate: async () => {
                    reached.resolve();
                    await resume.promise;
                },
            });
            const sending = transport.dispatch(captured);
            await reached.promise;
            edit(source, replacement);
            resume.resolve();
            const result = await sending;
            expect(result.writeInitiated).to.equal(false);
            expect(transport.bodies).to.have.length(0);
            settleTransport(captured, result);
            if (replacement === "A") {
                await f.evaluated(() => edit(source, "A"));
                expect(f.offered).to.have.length(1);
            } else {
                await waitFor(() => f.offered.length === 2, 15_000);
                expect(f.offered[1].eventId).not.to.equal(captured.eventId);
                expect(JSON.stringify(f.offered[1].summary)).to.contain("C");
            }
        });
    }

    it("advances once after an observed first write despite failure and a cancelled second destination", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.offered.length === 1, 15_000);
        const captured = f.offered[0];
        const transport = observedTransport({ holdResponse: true, responseStatus: 503 });
        const sending = transport.dispatch(captured);
        await waitFor(() => transport.bodies.length === 1);
        edit(source, "C");
        const cancelled = observedTransport();
        const other = await cancelled.dispatch(captured);
        expect(other.writeInitiated).to.equal(false);
        transport.finishResponse();
        const result = await sending;
        expect(result).to.include({ kind: "http_error", writeInitiated: true, status: 503 });
        settleTransport(captured, result);
        settleTransport(captured, result);
        await waitFor(() => f.offered.length === 2, 15_000);
        expect(JSON.stringify(f.offered[1].summary)).to.contain("C");
        // If B was settled, returning to B cancels C; keeping A incorrectly produces another event.
        edit(source, "B");
        expect((await f.offered[1].revalidate()).status).not.to.equal("current");
        f.offered[1].settleAttempt({ initiated: false, outcome: "cancelled" });
        await f.evaluated(() => edit(source, "B"));
        expect(f.offered).to.have.length(2);
        expect(transport.bodies).to.have.length(1);
    });
});
