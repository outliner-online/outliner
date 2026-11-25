import { expect } from "chai";
import { CredentialEnvelope } from "../src/notifications/credential-envelope.js";
import { NotificationEventsService } from "../src/notifications/mcp-events-service.js";
import { McpLeaseStore } from "../src/notifications/mcp-lease-store.js";
import { KEY, mount, receiver, rpc, subscription, token } from "./mcp-events-fixture.js";
import {
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./notifications/observation-runtime.fixture.js";

describe("restart retains route and settings without delivery replay", function() {
    this.timeout(60000);
    let f: RuntimeFixture;
    let events: NotificationEventsService;
    afterEach(async () => {
        await events?.close();
        await f?.close();
    });
    it("reopens real SQLite and live project rooms with silent baselines and absent delivery evidence", async () => {
        f = await runtimeFixture({}, {}, undefined, { captureMcp: false });
        await f.seed();
        let network = receiver();
        const create = () =>
            new NotificationEventsService(
                new McpLeaseStore(() => f.server.persistence!.db, new CredentialEnvelope(KEY)),
                f.runtime,
                network.sender,
            );
        events = create();
        const registration = await rpc(mount(events), "events/subscribe", subscription, token(UID));
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
        const write = (value: string) =>
            f.call("write_relation", {
                projectId: PROJECT,
                relation: "tasks",
                write: { op: "UPDATE", rowId: "a", column: "title", value },
            });
        await write("Before restart");
        await waitFor(() => events.status(UID).latestAttempt === "accepted", 15000);
        const expiry = events.status(UID).expiresAtMs;
        const directory = f.directory;
        await events.close();
        await f.close();
        f = await runtimeFixture({}, {}, directory, { captureMcp: false });
        network = receiver();
        events = create();
        expect(events.status(UID)).to.deep.equal({ state: "active", expiresAtMs: expiry, latestAttempt: null });
        expect(f.server.notificationSettings.get(UID).rules).to.deep.equal([rule()]);
        f.runtime.start();
        await f.watching(["watch-grid"]);
        expect(network.bodies).to.have.length(0);
        await f.runtime.reconcile();
        await f.watching(["watch-grid"]);
        expect(network.bodies).to.have.length(0);
        await write("After restart");
        await waitFor(() => network.bodies.length === 1, 15000);
        expect(network.bodies[0].headers["x-mcp-subscription-id"]).to.equal(registration.result.id);
        expect(network.bodies[0].body.data.samples[0].oldDisplay).to.contain("Before restart");
        expect(network.bodies[0].body.data.samples[0].newDisplay).to.contain("After restart");
        expect(network.bodies.filter(record => record.body.challenge)).to.have.length(0);
    });
});
