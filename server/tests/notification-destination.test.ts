import { expect } from "chai";
import {
    isPublicIpv4,
    validateHttpsDestination,
    validateResolvedIpv4,
} from "../src/notifications/https-destination.js";
import { sendNotificationHttps, validateNotificationHeaders } from "../src/notifications/https-transport.js";

describe("notification HTTPS destination admission", () => {
    it("accepts only the bounded canonical HTTPS grammar", () => {
        expect(validateHttpsDestination("https://example.com/events?q=opaque")?.hostname).to.equal("example.com");
        for (const value of [
            "http://example.com/",
            "https://user@example.com/",
            "https://example.com:444/",
            "https://127.0.0.1/",
            "https://example.com/#fragment",
            `https://example.com/${"x".repeat(2048)}`,
            "https://example.com/\nsecret",
        ]) expect(validateHttpsDestination(value), value).to.equal(undefined);
    });

    it("rejects every non-public or mixed resolution atomically", () => {
        for (
            const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
                "192.0.2.1", "192.168.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1"]
        ) {
            expect(isPublicIpv4(address), address).to.equal(false);
        }
        expect(validateResolvedIpv4(["8.8.8.8"])).to.deep.equal(["8.8.8.8"]);
        expect(validateResolvedIpv4(["8.8.8.8", "10.0.0.1"])).to.equal(undefined);
        expect(validateResolvedIpv4([])).to.equal(undefined);
    });

    it("admits only the two bounded outbound header profiles", () => {
        expect(validateNotificationHeaders("mcp-events", {
            "Content-Type": "application/json",
            "Webhook-Id": "evt_1",
            "Webhook-Timestamp": "1700000000",
            "Webhook-Signature": "v1,signature",
            "X-MCP-Subscription-Id": "sub_1",
        })).to.include({ "content-type": "application/json", "webhook-id": "evt_1" });
        expect(validateNotificationHeaders("web-push", {
            "Content-Encoding": "aes128gcm",
            TTL: "60",
            Urgency: "normal",
            Authorization: "vapid t=token,k=key",
            "Crypto-Key": "dh=value",
        })).to.include({ authorization: "vapid t=token,k=key" });
        expect(validateNotificationHeaders("web-push", { Authorization: "Bearer secret" })).to.equal(undefined);
        expect(validateNotificationHeaders("mcp-events", { Host: "attacker.test" })).to.equal(undefined);
        expect(validateNotificationHeaders("mcp-events", { "Webhook-Id": "ok\r\nCookie: secret" })).to.equal(undefined);
        expect(validateNotificationHeaders("mcp-events", { "Webhook-Id": "one", "webhook-id": "two" })).to.equal(
            undefined,
        );
    });

    it("refuses invalid destinations and stale authorization before network or preparation", async () => {
        let prepared = false;
        const base = {
            headerProfile: "mcp-events" as const,
            responseMode: "status" as const,
            authorizationDeadlineMs: Date.now() + 1_000,
            beforeSend: async () => {
                prepared = true;
                return null;
            },
        };
        expect(await sendNotificationHttps({ ...base, url: "http://example.com", canStart: () => true })).to.deep.equal(
            {
                kind: "rejected",
                reason: "destination",
                writeInitiated: false,
            },
        );
        expect(await sendNotificationHttps({ ...base, url: "https://example.com", canStart: () => false })).to.deep
            .equal({
                kind: "rejected",
                reason: "authorization",
                writeInitiated: false,
            });
        expect(prepared).to.equal(false);
    });
});
