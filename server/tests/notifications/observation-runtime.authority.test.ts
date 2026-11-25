import { expect } from "chai";
import {
    deferred,
    edit,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./observation-runtime.fixture.js";
import { observedTransport, settleTransport } from "./observation-runtime.transport.js";

describe("notification runtime rule and access authority", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("honors a mobile-only MCP disable during a real held evaluation while MCP keeps progressing", async () => {
        const reached = deferred(), resume = deferred();
        let hold = false;
        f = await runtimeFixture({}, {
            beforeFinalCertification: async () => {
                if (!hold) return;
                hold = false;
                reached.resolve();
                await resume.promise;
            },
        });
        const { source } = await f.seed();
        const both = { ...rule(), channels: { mcp: true, mobile: true } };
        f.runtime.start();
        await f.update([both]);
        await f.watching(["watch-grid"]);
        hold = true;
        edit(source, "B");
        await reached.promise;
        try {
            await f.update([{ ...both, channels: { mcp: true, mobile: false } }]);
        } finally {
            resume.resolve();
        }
        await waitFor(() => f.offered.length > 0, 15_000);
        expect(f.offered.every(candidate => candidate.channel === "mcp")).to.equal(true);
        expect(f.runtime.status(UID).some(status => status.channel === "mobile" && status.state === "disabled"))
            .to.equal(true);
        const transport = observedTransport();
        const sent = await transport.dispatch(f.offered[0]);
        expect(sent.writeInitiated).to.equal(true);
        settleTransport(f.offered[0], sent);
        edit(source, "C");
        await waitFor(() => f.offered.length === 2, 15_000);
        expect(f.offered.every(candidate => candidate.channel === "mcp")).to.equal(true);
    });

    it("keeps both channel payloads current across their separate revalidation reads", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([{ ...rule(), channels: { mcp: true, mobile: true } }]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.offered.length === 2, 15_000);
        const mcp = f.offered.find(candidate => candidate.channel === "mcp")!;
        const mobile = f.offered.find(candidate => candidate.channel === "mobile")!;
        const first = await mcp.revalidate();
        const second = await mobile.revalidate();
        expect(first.status).to.equal("current");
        expect(second.status).to.equal("current");
        if (first.status !== "current" || second.status !== "current") throw new Error("Both channels must certify");
        expect(first.candidate.isCurrent()).to.equal(true);
        expect(second.candidate.isCurrent()).to.equal(true);
        expect(first.candidate.eventId).to.equal(mcp.eventId);
        expect(second.candidate.eventId).to.equal(mobile.eventId);
    });

    for (const intervention of ["remove", "disable", "context", "access", "access-error", "delete"] as const) {
        it(`refuses a captured payload after ${intervention} at the pre-write boundary`, async () => {
            f = await runtimeFixture();
            const { source, project } = await f.seed();
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
            const pending = transport.dispatch(captured);
            await reached.promise;
            try {
                if (intervention === "remove") await f.update([], ["watch-grid"]);
                if (intervention === "disable") await f.update([{ ...rule(), enabled: false }]);
                if (intervention === "context") {
                    await f.update([{ ...rule(), context: { ...rule().context, timeZone: "Asia/Tokyo" } }]);
                }
                if (intervention === "access") f.acl.revokeAll(PROJECT);
                if (intervention === "access-error") f.acl.failing = true;
                if (intervention === "delete") project.getMap("yjsGrids").delete("watched");
            } finally {
                resume.resolve();
            }
            const outcome = await pending;
            expect(outcome.writeInitiated).to.equal(false);
            expect(transport.bodies).to.have.length(0);
            settleTransport(captured, outcome);
            expect((await captured.revalidate()).status).not.to.equal("current");
            if (intervention === "context") {
                await f.watching(["watch-grid"]);
                expect(f.offered).to.have.length(1);
                edit(source, "C");
                await waitFor(() => f.offered.length === 2, 15_000);
                expect(f.offered[1].effectiveContext.timeZone).to.equal("Asia/Tokyo");
            }
        });
    }
});
