import { expect } from "chai";
import { CredentialEnvelope } from "../../src/notifications/credential-envelope.js";
import { NotificationEventsService } from "../../src/notifications/mcp-events-service.js";
import { McpLeaseStore } from "../../src/notifications/mcp-lease-store.js";
import { KEY, mount, receiver, rpc, subscription, token } from "../mcp-events-fixture.js";
import { edit, rule, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush } from "./web-push-crypto.fixture.js";
import { type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("independent production Mobile and MCP delivery channels", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    let events: NotificationEventsService;
    afterEach(async () => {
        await events?.close();
        await f?.close();
    });

    for (const retired of ["mcp", "mobile"] as const) {
        it(`delivers through both adapters and preserves the other channel when ${retired} closes`, async () => {
            f = await webPushFixture({ captureMcp: false });
            const device = await f.enroll();
            const { source } = await f.seed();
            const network = receiver();
            events = new NotificationEventsService(
                new McpLeaseStore(() => f.server.persistence!.db, new CredentialEnvelope(KEY)),
                f.runtime,
                network.sender,
            );
            const registration = await rpc(mount(events), "events/subscribe", subscription, token(UID));
            expect(registration.error, JSON.stringify(registration)).to.equal(undefined);
            f.runtime.start();
            await f.update([{ ...rule(), channels: { mcp: true, mobile: true } }]);
            await waitFor(
                () =>
                    ["mcp", "mobile"].every(channel =>
                        f.runtime.status(UID).some(status =>
                            status.ruleId === "watch-grid" && status.channel === channel && status.state === "watching"
                        )
                    ),
                15_000,
            );
            const changedEvents = () => network.bodies.filter(record => record.body.name);
            expect(changedEvents()).to.have.length(0);
            expect(f.captured.requests).to.have.length(0);

            edit(source, "Both channels B");
            await waitFor(() =>
                changedEvents().length === 1 && f.captured.requests.length === 1
                && f.runtime.diagnostics().candidates === 0, 20_000);
            const firstMobile = decryptPush(f.captured.requests[0], device);
            expect(firstMobile.payload.body).to.contain("Both channels B");
            expect(firstMobile.plaintext.toString()).not.to.contain(UID);
            expect(firstMobile.payload).not.to.have.property("uid");
            expect(changedEvents()[0].body.data.samples[0].newDisplay).to.contain("Both channels B");
            expect(f.settlements.filter(outcome => outcome.initiated)).to.deep.equal([
                { initiated: true, outcome: "accepted" },
            ]);

            if (retired === "mcp") await events.close();
            else f.adapter.close();
            expect(f.runtime.isClosed()).to.equal(false);
            edit(source, "Remaining channel C");
            await waitFor(() =>
                (retired === "mcp" ? f.captured.requests.length : changedEvents().length) === 2
                && f.runtime.diagnostics().candidates === 0, 20_000);
            if (retired === "mcp") {
                expect(changedEvents()).to.have.length(1);
                expect(decryptPush(f.captured.requests[1], device).payload.body).to.contain("Remaining channel C");
            } else {
                expect(f.captured.requests).to.have.length(1);
                expect(changedEvents()[1].body.data.samples[0].newDisplay).to.contain("Remaining channel C");
            }
        });
    }
});
