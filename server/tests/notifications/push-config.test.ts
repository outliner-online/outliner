import { expect } from "chai";
import { createECDH } from "node:crypto";
import { loadPushConfig } from "../../src/notifications/push-config.js";

describe("Web Push VAPID configuration", () => {
    it("requires a complete stable key pair and derives a non-secret identifier", () => {
        // A leading-zero scalar exercises the required 32-byte VAPID encoding.
        const privateKey = Buffer.alloc(32);
        privateKey[31] = 1;
        const pair = createECDH("prime256v1");
        pair.setPrivateKey(privateKey);
        const env = {
            WEB_PUSH_VAPID_PUBLIC_KEY: pair.getPublicKey(undefined, "uncompressed").toString("base64url"),
            WEB_PUSH_VAPID_PRIVATE_KEY: privateKey.toString("base64url"),
            WEB_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
        };
        const first = loadPushConfig(env);
        expect(first).to.include({ publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY, subject: env.WEB_PUSH_VAPID_SUBJECT });
        expect(first?.vapidKeyId).to.equal(loadPushConfig(env)?.vapidKeyId);
        const otherPrivateKey = Buffer.from(privateKey);
        otherPrivateKey[31] = 2;
        expect(loadPushConfig({ ...env, WEB_PUSH_VAPID_PRIVATE_KEY: otherPrivateKey.toString("base64url") }))
            .to.equal(undefined);
        expect(loadPushConfig({ ...env, WEB_PUSH_VAPID_PRIVATE_KEY: pair.getPrivateKey().toString("base64url") }))
            .to.equal(undefined);
        expect(loadPushConfig({})).to.equal(undefined);
    });
});
