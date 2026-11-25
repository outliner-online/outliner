import { expect } from "chai";
import { NotificationEventsService } from "../src/notifications/mcp-events-service.js";
import { eventsFixture, held, mount, rpc, SECRET, subscription, tuple } from "./mcp-events-fixture.js";
import { waitFor } from "./server-create-table-fixture.js";

describe("signed callback challenge races", () => {
    let f: ReturnType<typeof eventsFixture>;
    beforeEach(() => {
        f = eventsFixture();
    });
    afterEach(async () => {
        await f.close();
    });
    it("keeps the old route on failed refresh and invalidates held refresh on unsubscribe", async () => {
        const original = await rpc(f.app, "events/subscribe", subscription);
        const active = f.store.capture("owner")!;
        f.network.validChallenge = false;
        expect((await rpc(f.app, "events/subscribe", subscription)).error.data.code).to.equal("verification_failed");
        expect(f.store.isCurrent(active)).to.equal(true);
        f.network.validChallenge = true;
        const challenge = held();
        f.network.challengeReply = () => challenge.promise;
        const refreshing = rpc(f.app, "events/subscribe", subscription);
        await waitFor(() => f.network.bodies.length === 3);
        expect(f.events.status("owner").state).to.equal("pending");
        await rpc(f.app, "events/unsubscribe", tuple);
        challenge.resolve();
        expect((await refreshing).error.data.code).to.equal("expired");
        expect(f.store.capture("owner")).to.equal(undefined);
        f.network.challengeReply = undefined;
        const replacement = await rpc(f.app, "events/subscribe", subscription);
        expect(replacement.result.id).not.to.equal(original.result.id);
    });
    it("lets the latest same-identity candidate win without a delayed challenge overwriting it", async () => {
        const gate = held();
        f.network.challengeReply = () => gate.promise;
        const first = rpc(f.app, "events/subscribe", subscription);
        await waitFor(() => f.network.bodies.length === 1);
        f.network.challengeReply = undefined;
        const second = await rpc(f.app, "events/subscribe", subscription);
        const current = f.store.capture("owner")!;
        gate.resolve();
        expect((await first).error.data.code).to.equal("expired");
        expect(f.store.isCurrent(current)).to.equal(true);
        expect(current.subscriptionId).to.equal(second.result.id);
    });
    it("does not activate a challenge that completes after ttl, closed storage or shutdown", async () => {
        const gate = held();
        f.network.challengeReply = () => gate.promise;
        const expired = rpc(f.app, "events/subscribe", { ...subscription, ttlMs: 50 });
        await waitFor(() => f.network.bodies.length === 1);
        await new Promise(resolve => setTimeout(resolve, 70));
        gate.resolve();
        expect((await expired).error).to.exist;
        expect(f.store.capture("owner")).to.equal(undefined);
        f.network.challengeReply = undefined;
        const secondGate = held();
        f.network.challengeReply = () => secondGate.promise;
        const closed = rpc(f.app, "events/subscribe", subscription);
        await waitFor(() => f.network.bodies.length === 2);
        f.db.close();
        secondGate.resolve();
        expect((await closed).error.data.code).to.equal("unavailable");
        expect(f.events.status("owner").state).to.equal("unavailable");
    });
    it("aborts a pending challenge on shutdown without allowing late activation", async () => {
        await rpc(f.app, "events/subscribe", subscription);
        const active = f.store.capture("owner")!;
        const gate = held();
        f.network.challengeReply = () => gate.promise;
        const refresh = rpc(f.app, "events/subscribe", subscription);
        await waitFor(() => f.network.bodies.length === 2);
        await f.events.close();
        expect((await refresh).error).to.exist;
        gate.resolve();
        expect(f.store.isCurrent(active)).to.equal(true);
        expect(f.events.ready()).to.equal(false);
    });
    it("exposes no usable Events capability without a key and never returns default delivery success", async () => {
        await f.events.close();
        const unavailable = new NotificationEventsService(undefined, f.runtime, f.network.sender);
        try {
            const app = mount(unavailable);
            const status = await rpc(app, "tools/call", { name: "get_notification_delivery_status", arguments: {} });
            expect(status.result.structuredContent).to.deep.equal({ state: "unavailable", latestAttempt: null });
            expect((await rpc(app, "events/subscribe", subscription)).error).to.exist;
            expect(JSON.stringify(status)).not.to.contain(SECRET);
            expect(f.network.bodies).to.have.length(0);
        } finally {
            await unavailable.close();
        }
    });
});
