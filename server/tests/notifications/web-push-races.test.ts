import { expect } from "chai";
import { createECDH, createHash } from "node:crypto";
import { deferred, edit, PROJECT, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush } from "./web-push-crypto.fixture.js";
import { mobileRule, type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("Web Push exact-candidate pre-write races", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    afterEach(async () => f?.close());

    for (const replacement of ["A", "C"]) {
        it(`never writes B ciphertext after a source replacement with ${replacement}`, async () => {
            const reached = deferred(), resume = deferred();
            f = await webPushFixture({
                transportControls: {
                    beforeAuthorize: async (_input, index) => {
                        if (index !== 0) return;
                        reached.resolve();
                        await resume.promise;
                    },
                },
            });
            const receiver = await f.enroll();
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([mobileRule()]);
            await f.watching(["watch-grid"]);
            edit(source, "B");
            await reached.promise;
            expect(f.captured.requests).to.have.length(0);
            edit(source, replacement);
            resume.resolve();
            await waitFor(() => f.settlements.length >= 1, 20_000);
            expect(f.captured.outcomes[0].writeInitiated).to.equal(false);
            expect(f.settlements[0].initiated).to.equal(false);
            if (replacement === "A") {
                await f.evaluated(() => edit(source, "A"));
                expect(f.captured.requests).to.have.length(0);
                edit(source, "C");
            }
            await waitFor(() => f.settlements.length === 2, 20_000);
            expect(f.captured.requests).to.have.length(1);
            const payload = decryptPush(f.captured.requests[0], receiver).payload;
            expect(payload.body).to.contain("C").and.not.contain("title: B");
            expect(f.settlements[1]).to.deep.equal({ initiated: true, outcome: "accepted" });
        });
    }

    for (const change of ["mobile", "context", "object", "acl", "device", "replacement", "vapid"] as const) {
        it(`refuses an observed ${change} authority change after TLS preparation`, async () => {
            const reached = deferred(), resume = deferred();
            f = await webPushFixture({
                transportControls: {
                    beforeAuthorize: async () => {
                        reached.resolve();
                        await resume.promise;
                    },
                },
            });
            const receiver = await f.enroll();
            const { source, project } = await f.seed();
            const watched = { ...mobileRule(), channels: { mcp: true, mobile: true } };
            f.runtime.start();
            await f.update([watched]);
            await f.watching(["watch-grid"]);
            edit(source, "B");
            await reached.promise;
            if (change === "mobile") await f.update([{ ...watched, channels: { mcp: true, mobile: false } }]);
            else if (change === "context") {
                await f.update([{ ...watched, context: { ...watched.context, locale: "ja-JP" } }]);
            } else if (change === "object") project.getMap("yjsGrids").delete("watched");
            else if (change === "acl") f.acl.revokeAll(PROJECT);
            else if (change === "device") await f.disable(receiver.deviceId);
            else if (change === "vapid") {
                const key = createECDH("prime256v1");
                const publicKey = key.generateKeys();
                const scalar = key.getPrivateKey();
                Object.assign(f.config, {
                    publicKey: publicKey.toString("base64url"),
                    privateKey: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString("base64url"),
                    vapidKeyId: createHash("sha256").update(publicKey).digest("base64url"),
                });
            } else await f.enroll(receiver.deviceId);
            resume.resolve();
            await waitFor(() => f.settlements.length === 1, 20_000);
            expect(f.captured.requests).to.have.length(0);
            expect(f.settlements[0].initiated).to.equal(false);
            if (change !== "acl") {
                expect(f.server.notificationSettings.get(UID).rules[0].channels.mcp).to.equal(true);
                expect(f.offered.some(candidate => candidate.channel === "mcp")).to.equal(true);
            }
        });
    }

    it("checks exact source currency after revalidation and offers replacement C separately", async () => {
        const reached = deferred(), resume = deferred();
        f = await webPushFixture({
            transportControls: {
                afterAuthorize: async (_input, index) => {
                    if (index !== 0) return;
                    reached.resolve();
                    await resume.promise;
                },
            },
        });
        const receiver = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await reached.promise;
        edit(source, "C");
        resume.resolve();
        await waitFor(() => f.settlements.length === 2, 20_000);
        expect(f.captured.outcomes[0].writeInitiated).to.equal(false);
        expect(f.captured.requests).to.have.length(1);
        expect(decryptPush(f.captured.requests[0], receiver).payload.body).to.contain("C");
    });

    it("checks device revision synchronously after producer revalidation and all asynchronous preparation", async () => {
        const reached = deferred(), resume = deferred();
        f = await webPushFixture({
            transportControls: {
                afterAuthorize: async () => {
                    reached.resolve();
                    await resume.promise;
                },
            },
        });
        const receiver = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await reached.promise;
        await f.disable(receiver.deviceId);
        resume.resolve();
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.captured.requests).to.have.length(0);
        expect(f.captured.outcomes[0]).to.include({ writeInitiated: false });
    });
});
