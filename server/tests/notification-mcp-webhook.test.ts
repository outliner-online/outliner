import { expect } from "chai";
import { Webhook } from "standardwebhooks";
import { signMcpWebhook } from "../src/notifications/mcp-webhook.js";

describe("MCP webhook signing", () => {
    it("signs and returns the same exact Unicode serialization", () => {
        const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
        const timestampMs = Date.now();
        const signed = signMcpWebhook({
            body: { text: "雪🌨️" },
            eventId: "evt_1",
            subscriptionId: "sub_1",
            secret,
            timestampMs,
        });
        expect(Buffer.from(signed.body).toString()).to.equal('{"text":"雪🌨️"}');
        expect(signed.headers["x-mcp-subscription-id"]).to.equal("sub_1");
        const verified = new Webhook(secret).verify(Buffer.from(signed.body), {
            "webhook-id": signed.headers["webhook-id"],
            "webhook-timestamp": signed.headers["webhook-timestamp"],
            "webhook-signature": signed.headers["webhook-signature"],
        });
        expect(verified).to.deep.equal({ text: "雪🌨️" });
    });

    it("rejects invalid client secrets without exposing them", () => {
        expect(() =>
            signMcpWebhook({
                body: {},
                eventId: "e",
                subscriptionId: "s",
                secret: "opaque-secret",
                timestampMs: Date.now(),
            })
        )
            .to.throw("invalid signing secret");
    });
});
