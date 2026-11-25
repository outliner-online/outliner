import { expect } from "chai";
import { eventsFixture, held, rpc, subscription, tuple } from "./mcp-events-fixture.js";
import { preparedFixture } from "./mcp-events-prepared-fixture.js";
import { waitFor } from "./server-create-table-fixture.js";

describe("bounded best-effort one-attempt delivery evidence", () => {
    let f: ReturnType<typeof eventsFixture>;
    beforeEach(async () => {
        f = eventsFixture();
        await rpc(f.app, "events/subscribe", subscription);
    });
    afterEach(async () => {
        await f.close();
    });
    it("settles receiver acceptance, rejection and response loss exactly once without retries", async () => {
        for (
            const [status, loss, expected] of [[204, false, "accepted"], [429, false, "failed"], [503, false, "failed"],
                [204, true, "unknown"]] as const
        ) {
            f.network.responseStatus = status;
            f.network.loseResponse = loss;
            const p = preparedFixture();
            const before = f.network.requests;
            await f.events.deliver(p.prepared);
            expect(p.settled).to.deep.equal([{ initiated: true, outcome: expected }]);
            expect(f.network.requests).to.equal(before + 1);
            expect(f.events.status("owner").latestAttempt).to.equal(expected);
            expect(f.store.capture("owner")).to.exist;
        }
        const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        expect(tables).to.deep.equal([{ name: "notification_mcp_leases" }]);
        expect(JSON.stringify(f.db.prepare("SELECT * FROM notification_mcp_leases").all())).not.to.contain(
            "exact-A-to-B",
        );
    });
    it("preserves unknown if end throws after write initiation", async () => {
        f.network.throwAfterWrite = true;
        const p = preparedFixture();
        const count = f.network.requests;
        await f.events.deliver(p.prepared);
        expect(p.settled).to.deep.equal([{ initiated: true, outcome: "unknown" }]);
        expect(f.network.requests).to.equal(count + 1);
    });
    it("disables only the current generation on 410 and drops late/absent destinations", async () => {
        f.network.responseStatus = 410;
        const p = preparedFixture();
        await f.events.deliver(p.prepared);
        expect(p.settled).to.deep.equal([{ initiated: true, outcome: "failed" }]);
        expect(f.events.status("owner").state).to.equal("disabled");
        const absent = preparedFixture();
        const count = f.network.requests;
        await f.events.deliver(absent.prepared);
        expect(absent.settled).to.deep.equal([{ initiated: false, outcome: "no_destination" }]);
        await rpc(f.app, "events/subscribe", subscription);
        expect(f.network.requests).to.equal(count + 1); // challenge only; no deferred event replay
    });
    it("does not let a delayed old-generation 410 disable a refreshed lease", async () => {
        const gate = held();
        f.network.eventReply = () => gate.promise;
        f.network.responseStatus = 410;
        const p = preparedFixture();
        const attempt = f.events.deliver(p.prepared);
        await waitFor(() => f.network.bodies.some(record => record.body.name));
        const old = f.store.capture("owner")!;
        await rpc(f.app, "events/subscribe", subscription);
        const renewed = f.store.capture("owner")!;
        expect(renewed.generation).to.be.greaterThan(old.generation);
        gate.resolve();
        await attempt;
        expect(f.store.isCurrent(renewed)).to.equal(true);
        expect(p.settled).to.deep.equal([{ initiated: true, outcome: "failed" }]);
    });
    it("erases credentials at expiry without requiring a new event and stops pending writes", async () => {
        await rpc(f.app, "events/unsubscribe", tuple);
        await rpc(f.app, "events/subscribe", { ...subscription, ttlMs: 80 });
        const gate = held();
        let entered = false;
        f.network.beforeTls = () => {
            entered = true;
            return gate.promise;
        };
        const p = preparedFixture();
        const attempt = f.events.deliver(p.prepared);
        await waitFor(() => entered);
        await waitFor(() =>
            (f.db.prepare("SELECT active FROM notification_mcp_leases WHERE uid='owner'").get() as { active: unknown; })
                .active === null
        );
        gate.resolve();
        await attempt;
        expect(p.settled).to.deep.equal([{ initiated: false, outcome: "expired" }]);
        expect(f.network.bodies.filter(record => record.body.name)).to.have.length(0);
        expect(f.events.status("owner").state).to.equal("expired");
    });
});
