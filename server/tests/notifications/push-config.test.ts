import { expect } from "chai";
import { loadPushConfig } from "../../src/notifications/push-config.js";

describe("Web Push VAPID configuration", () => {
    it("requires a complete stable key pair and derives a non-secret identifier", () => {
        const env = {
            WEB_PUSH_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 3)]).toString("base64url"),
            WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 4).toString("base64url"),
            WEB_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
        };
        const first = loadPushConfig(env);
        expect(first).to.include({ publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY, subject: env.WEB_PUSH_VAPID_SUBJECT });
        expect(first?.vapidKeyId).to.equal(loadPushConfig(env)?.vapidKeyId);
        expect(loadPushConfig({})).to.equal(undefined);
    });
});
