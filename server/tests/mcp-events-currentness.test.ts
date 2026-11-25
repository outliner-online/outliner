import { expect } from "chai";
import { buildChangedEvent } from "../src/notifications/mcp-events-protocol.js";
import { summarizeViewChange } from "../src/notifications/prepared-view-change.js";
import { eventsFixture, held, rpc, subscription, tuple } from "./mcp-events-fixture.js";
import { waitFor } from "./server-create-table-fixture.js";

import { preparedFixture } from "./mcp-events-prepared-fixture.js";

describe("exact post-connect candidate and lease guards", () => {
    let f: ReturnType<typeof eventsFixture>;
    beforeEach(async () => {
        f = eventsFixture();
        await rpc(f.app, "events/subscribe", subscription);
    });
    afterEach(async () => {
        await f.close();
    });
    it("does not write cancelled/deferred A-to-B after delayed DNS", async () => {
        for (const status of ["cancelled", "deferred"] as const) {
            const p = preparedFixture();
            const gate = held();
            let entered = false;
            f.network.beforeTls = () => {
                entered = true;
                return gate.promise;
            };
            const attempt = f.events.deliver(p.prepared);
            await waitFor(() => entered);
            p.status = status;
            gate.resolve();
            await attempt;
            expect(p.settled).to.deep.equal([{ initiated: false, outcome: status }]);
        }
        expect(f.network.bodies).to.have.length(1);
    });
    it("checks candidate currentness synchronously immediately before end", async () => {
        const p = preparedFixture();
        f.network.beforeWrite = () => p.stale();
        await f.events.deliver(p.prepared);
        expect(f.network.bodies).to.have.length(1);
        expect(p.settled).to.deep.equal([{ initiated: false, outcome: "deferred" }]);
    });
    it("checks the exact lease generation synchronously immediately before end", async () => {
        const p = preparedFixture();
        const lease = f.store.capture("owner")!;
        f.network.beforeWrite = () => f.store.remove("owner", lease.identity);
        await f.events.deliver(p.prepared);
        expect(f.network.bodies).to.have.length(1);
        expect(p.settled).to.deep.equal([{ initiated: false, outcome: "no_destination" }]);
    });
    it("does not rebind an old TLS attempt to refreshed credentials or a later subscription", async () => {
        const p = preparedFixture();
        const gate = held();
        let entered = false;
        f.network.beforeTls = () => {
            entered = true;
            return gate.promise;
        };
        const attempt = f.events.deliver(p.prepared);
        await waitFor(() => entered);
        f.network.beforeTls = undefined;
        await rpc(f.app, "events/unsubscribe", tuple);
        await rpc(f.app, "events/subscribe", subscription);
        gate.resolve();
        await attempt;
        expect(p.settled).to.deep.equal([{ initiated: false, outcome: "no_destination" }]);
        expect(f.network.bodies.filter(record => record.body.name)).to.have.length(0);
    });
    it("bounds paired display samples and reduces only structured samples for large envelopes", () => {
        const p = preparedFixture().prepared;
        const grid = (value: string) => ({
            kind: "grid" as const,
            title: "Visible",
            columns: [{ label: "Title" }],
            rows: Array.from({ length: 4 }, () => [{ value }]),
        });
        const summary = summarizeViewChange(grid("😀".repeat(150)), grid("雪".repeat(150)));
        expect(summary.samples).to.have.length(3);
        expect(summary.samples[0].oldTruncated).to.equal(true);
        expect(summary.samples[0].newTruncated).to.equal(true);
        expect([...summary.samples[0].oldDisplay]).to.have.length(120);
        const event = buildChangedEvent({ ...p, summary }, Date.now()) as any;
        expect(event.data.samplesTruncated).to.equal(true);
        expect(event.data.valuesTruncated).to.equal(true);
        expect(JSON.stringify(event)).not.to.contain("private-token").and.not.to.contain("effectiveContext");
        const large = buildChangedEvent({ ...p, summary, deepLink: "https://outliner.example/" + "x".repeat(15100) },
            Date.now()) as any;
        expect(Buffer.byteLength(JSON.stringify(large))).to.be.at.most(16384);
        expect(large.data.samples.length).to.be.lessThan(3);
        expect(large.data.deepLink).to.equal("https://outliner.example/" + "x".repeat(15100));
        expect(() => buildChangedEvent({ ...p, deepLink: "x".repeat(17000) }, Date.now())).to.throw("body bound");
    });
});
