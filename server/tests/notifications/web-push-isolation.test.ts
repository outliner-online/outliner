import { expect } from "chai";
import { edit, PROJECT, rule, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush } from "./web-push-crypto.fixture.js";
import { mobileRule, type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("Web Push owner, project and bounded-device isolation", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    afterEach(async () => f?.close());

    it("routes equal object and rule IDs only to their authoritative owners and enabled channels", async () => {
        f = await webPushFixture();
        const ownerA = await f.enroll("browser_device_owner_a", UID);
        const ownerB = await f.enroll("browser_device_owner_b", "other-owner");
        const first = await f.seed();
        const second = await f.seed("another-project", "other-owner");
        f.runtime.start();
        await f.update([mobileRule()], [], UID);
        await f.update([mobileRule(rule("watch-grid", "another-project"))], [], "other-owner");
        await f.watching(["watch-grid"], UID);
        await f.watching(["watch-grid"], "other-owner");
        edit(first.source, "Owner A change");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.captured.requests).to.have.length(1);
        expect(String(f.captured.requests[0].options.path)).to.contain(ownerA.deviceId);
        expect(decryptPush(f.captured.requests[0], ownerA).payload.target.projectId).to.equal(PROJECT);
        edit(second.source, "Owner B change");
        await waitFor(() => f.settlements.length === 2, 20_000);
        expect(String(f.captured.requests[1].options.path)).to.contain(ownerB.deviceId);
        expect(decryptPush(f.captured.requests[1], ownerB).payload.target.projectId).to.equal("another-project");
        await f.update([{ ...mobileRule(), channels: { mcp: true, mobile: false } }]);
        await f.watching(["watch-grid"]);
        edit(first.source, "MCP-only change");
        await waitFor(() => f.offered.length === 1, 20_000);
        expect(f.offered[0].channel).to.equal("mcp");
        expect(f.captured.requests).to.have.length(2);
        expect(f.store.get(UID, ownerA.deviceId)?.revision).to.equal(ownerA.revision);
    });

    it("attempts the entire privately bounded active set without truncating eligible devices", async () => {
        f = await webPushFixture();
        const receivers = [];
        for (let index = 0; index < 16; index++) {
            receivers.push(await f.enroll(`bounded_browser_device_${index}`));
        }
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "All enrolled devices");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.captured.requests).to.have.length(16);
        expect(new Set(f.captured.requests.map(captured => captured.options.path)).size).to.equal(16);
        const payloads = f.captured.requests.map(captured => {
            const receiver = receivers.find(value =>
                String(captured.options.path).includes(`/send/${value.deviceId}?`)
            )!;
            return decryptPush(captured, receiver).payload;
        });
        expect(new Set(payloads.map(payload => payload.eventId)).size).to.equal(1);
        expect(new Set(payloads.map(payload => payload.enrollmentGeneration)).size).to.equal(16);
        expect(
            new Set(f.captured.requests.map(captured => (captured.options.headers as Record<string, string>).topic))
                .size,
        ).to.equal(16);
    });

    it("preserves producer truncation and never expands a long displayed example into a source snapshot", async () => {
        f = await webPushFixture();
        const receiver = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "表示🦊".repeat(500));
        await waitFor(() => f.settlements.length === 1, 20_000);
        const { payload, plaintext } = decryptPush(f.captured.requests[0], receiver);
        expect(plaintext.byteLength).to.be.at.most(3000);
        expect(payload.body).to.contain("…");
        expect(payload.body).not.to.contain("表示🦊".repeat(100));
        expect(plaintext.toString()).not.to.contain("SECRET");
    });
});
