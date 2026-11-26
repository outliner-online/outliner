import { expect } from "chai";
import { deferred, edit, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush } from "./web-push-crypto.fixture.js";
import { mobileRule, type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("Web Push bounded best-effort settlement", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    afterEach(async () => f?.close());

    it("attempts the independent device once despite 429, 500, ambiguous receipt and 410", async () => {
        let status: number | "unknown" = 429;
        f = await webPushFixture({
            transportControls: {
                response: captured => String(captured.options.path).includes("device_failure") ? status : 201,
            },
        });
        const failing = await f.enroll("browser_device_failure");
        const good = await f.enroll("browser_device_success");
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        for (const [index, outcome] of ([429, 500, "unknown", 410] as const).entries()) {
            status = outcome;
            edit(source, `Change ${index}`);
            await waitFor(() => f.settlements.length === index + 1, 20_000);
            expect(f.captured.requests).to.have.length((index + 1) * 2);
            expect(f.settlements[index]).to.deep.equal({ initiated: true, outcome: "accepted" });
            const requests = f.captured.requests.slice(index * 2, index * 2 + 2);
            expect(new Set(requests.map(captured => captured.options.path)).size).to.equal(2);
            const accepted = requests.find(captured => String(captured.options.path).includes("device_success"))!;
            expect(decryptPush(accepted, good).payload.body).to.contain(`Change ${index}`);
            await f.evaluated(() => edit(source, `SECRET-${index}`, "a", "hidden"));
            expect(f.captured.calls).to.have.length((index + 1) * 2);
        }
        expect(f.store.get(UID, failing.deviceId)?.state).to.equal("disabled");
        expect(f.store.get(UID, good.deviceId)?.state).to.equal("registered");
        edit(source, "After expiration");
        await waitFor(() => f.settlements.length === 5, 20_000);
        expect(f.captured.requests).to.have.length(9);
        expect(String(f.captured.requests[8].options.path)).to.contain(good.deviceId);
    });

    it("does not expire a replacement registration when the old revision later returns 410", async () => {
        const response = deferred();
        let first = true;
        f = await webPushFixture({
            transportControls: {
                response: async () => {
                    if (!first) return 201;
                    first = false;
                    await response.promise;
                    return 410;
                },
            },
        });
        const old = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.captured.requests.length === 1, 20_000);
        const current = await f.enroll(old.deviceId);
        expect(current.revision).to.be.greaterThan(old.revision);
        response.resolve();
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.store.get(UID, current.deviceId)).to.include({ revision: current.revision, state: "registered" });
        edit(source, "C");
        await waitFor(() => f.settlements.length === 2, 20_000);
        expect(decryptPush(f.captured.requests[1], current).payload.enrollmentGeneration)
            .to.equal(current.enrollmentGeneration);
    });

    it("retains an earlier first-write fact when another destination is subsequently cancelled", async () => {
        const held = deferred(), resume = deferred(), response = deferred();
        f = await webPushFixture({
            transportControls: {
                beforeAuthorize: async (_input, index) => {
                    if (index !== 1) return;
                    held.resolve();
                    await resume.promise;
                },
                response: async () => {
                    await response.promise;
                    return 503;
                },
            },
        });
        await f.enroll("browser_device_first");
        const second = await f.enroll("browser_device_second");
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await held.promise;
        await waitFor(() => f.captured.requests.length === 1, 20_000);
        await f.disable(second.deviceId);
        resume.resolve();
        response.resolve();
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.settlements[0]).to.include({ initiated: true });
        expect(f.captured.requests).to.have.length(1);
        await f.evaluated(() => edit(source, "SECRET-after", "a", "hidden"));
        expect(f.captured.calls).to.have.length(2);
        expect(f.settlements).to.have.length(1);
    });
});
