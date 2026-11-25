import { expect } from "chai";
import request from "supertest";
import { verifyAccessToken } from "../src/oauth/tokens.js";
import { eventsFixture, rpc, SECRET, subscription, token, tuple, URL } from "./mcp-events-fixture.js";

describe("authenticated account Events protocol", () => {
    let f: ReturnType<typeof eventsFixture>;
    beforeEach(() => {
        f = eventsFixture();
    });
    afterEach(async () => {
        await f.close();
    });
    it("lists exactly one strict event, activates only after signed challenge and bounds to actual JWT exp", async () => {
        const bearer = token("owner", "chatgpt", 120);
        const discovered = await rpc(f.app, "server/discover", {}, bearer);
        expect(discovered.error, JSON.stringify(discovered)).to.equal(undefined);
        expect(discovered.result.capabilities.events).to.deep.equal({});
        const listed = await rpc(f.app, "events/list", {}, bearer);
        expect(listed.error, JSON.stringify(listed)).to.equal(undefined);
        expect(listed.result.events.map((e: any) => e.name)).to.deep.equal(["outliner.changed"]);
        expect(listed.result.events[0].inputSchema).to.deep.equal({
            type: "object",
            properties: {},
            additionalProperties: false,
        });
        const subscribed = await rpc(f.app, "events/subscribe", { ...subscription, ttlMs: 900_000 }, bearer);
        expect(subscribed.error, JSON.stringify(subscribed)).to.equal(undefined);
        expect(Date.parse(subscribed.result.refreshBefore)).to.equal(verifyAccessToken(bearer).expiresAtMs);
        expect(subscribed.result.cursor).to.equal(null);
        expect(subscribed.result.truncated).to.equal(false);
        expect(listed.result.events[0].delivery).to.deep.equal(["webhook"]);
        expect(listed.result.events[0].payloadSchema.type).to.equal("object");
        expect(f.network.bodies).to.have.length(1);
        expect(f.network.bodies[0].body.type).to.equal("verification");
        expect(f.store.capture("owner")!.subscriptionId).to.equal(subscribed.result.id);
        const status = await rpc(f.app, "tools/call", { name: "get_notification_delivery_status", arguments: {} },
            bearer);
        expect(status.result.structuredContent).to.deep.equal({
            state: "active",
            expiresAtMs: verifyAccessToken(bearer).expiresAtMs,
            latestAttempt: null,
        });
        expect(JSON.stringify(status)).not.to.contain(URL).and.not.to.contain(SECRET);
    });
    it("refuses expired authority and missing read scope before protocol dispatch", async () => {
        for (
            const [bearer, status] of [[token("owner", "chatgpt", -1), 401], [
                token("owner", "chatgpt", 60, "outliner.write"),
                403,
            ]] as const
        ) {
            const result = await request(f.app).post("/mcp").set("Authorization", `Bearer ${bearer}`)
                .send({ jsonrpc: "2.0", id: 1, method: "events/subscribe", params: subscription });
            expect(result.status).to.equal(status);
        }
        expect(f.network.bodies).to.have.length(0);
    });
    it("rejects replay, nonempty arguments, unknown fields, invalid ttl and oversized metadata without callbacks", async () => {
        for (const params of [
            { ...subscription, arguments: { projectId: "private" } },
            { ...subscription, ttlMs: 0 },
            { ...subscription, ttlMs: -1 },
            { ...subscription, ttlMs: 1.2 },
            { ...subscription, cursor: "old" },
            { ...subscription, userId: "other" },
            { ...subscription, _meta: { long: "x".repeat(5000) } },
        ]) expect((await rpc(f.app, "events/subscribe", params)).error).to.exist;
        expect((await rpc(f.app, "events/list", { cursor: "replay" })).error).to.exist;
        expect(f.network.bodies).to.have.length(0);
    });
    it("isolates users and conflicts across client IDs/callbacks without sending a challenge", async () => {
        await rpc(f.app, "events/subscribe", subscription);
        for (
            const [bearer, params] of [
                [token("owner", "second-client"), subscription],
                [token(), {
                    ...subscription,
                    delivery: { ...subscription.delivery, url: "https://events.example.com/second" },
                }],
            ] as const
        ) expect((await rpc(f.app, "events/subscribe", params, bearer)).error.data.code).to.equal("conflict");
        expect(f.network.bodies).to.have.length(1);
        await rpc(f.app, "events/subscribe", subscription, token("other"));
        expect(f.store.capture("other")!.subscriptionId).not.to.equal(f.store.capture("owner")!.subscriptionId);
        await rpc(f.app, "events/unsubscribe", tuple, token("other"));
        expect(f.store.capture("owner")).to.exist;
        await rpc(f.app, "events/unsubscribe", {
            ...tuple,
            delivery: { ...tuple.delivery, url: "https://events.example.com/stale" },
        });
        expect(f.store.capture("owner")).to.exist;
        await rpc(f.app, "events/unsubscribe", tuple);
        await rpc(f.app, "events/unsubscribe", tuple);
        expect(f.store.capture("owner")).to.equal(undefined);
    });
});
