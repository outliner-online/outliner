import { expect } from "chai";
import { CredentialEnvelope } from "../src/notifications/credential-envelope.js";
import { NotificationEventsService } from "../src/notifications/mcp-events-service.js";
import { McpLeaseStore } from "../src/notifications/mcp-lease-store.js";
import { KEY, mount, receiver, rpc, subscription, token } from "./mcp-events-fixture.js";
import {
    edit,
    kanbanRule,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./notifications/observation-runtime.fixture.js";

describe("account Events from actual live saved views", function() {
    this.timeout(60000);
    let f: RuntimeFixture;
    let events: NotificationEventsService;
    afterEach(async () => {
        await events?.close();
        await f?.close();
    });
    it("uses one callback for two projects and follows mutable rules in a third without resubscription", async () => {
        f = await runtimeFixture({}, {}, undefined, false);
        const first = await f.seed();
        await f.seed("second-project");
        await f.seed("third-project");
        const network = receiver();
        const store = new McpLeaseStore(() => f.server.persistence!.db, new CredentialEnvelope(KEY));
        events = new NotificationEventsService(store, f.runtime, network.sender);
        const app = mount(events);
        const registration = await rpc(app, "events/subscribe", subscription, token(UID));
        expect(registration.error, JSON.stringify(registration)).to.equal(undefined);
        f.runtime.start();
        await f.update([rule(), rule("second", "second-project")]);
        await f.watching(["watch-grid", "second"]);
        expect(network.bodies).to.have.length(1); // signed challenge only, silent baseline
        const write = (projectId: string, value: string) => f.call("write_relation", {
            projectId,
            relation: "tasks",
            write: { op: "UPDATE", rowId: "a", column: "title", value },
        });
        await write(PROJECT, "First visible update");
        await write("second-project", "Second visible update");
        await waitFor(() => network.bodies.filter(record => record.body.name).length === 2, 15000);
        const initial = network.bodies.filter(record => record.body.name);
        expect(initial.map(record => record.body.data.projectId).sort()).to.deep.equal(
            [PROJECT, "second-project"].sort(),
        );
        expect(initial.map(record => record.body.data.ruleId).sort()).to.deep.equal(["second", "watch-grid"]);
        for (const record of initial) {
            expect(record.headers["x-mcp-subscription-id"]).to.equal(registration.result.id);
            expect(record.body.data.samples[0].oldDisplay).to.contain("A");
            expect(record.body.data.samples[0].newDisplay).to.contain("visible update");
            expect(record.body.cursor).to.equal(null);
            expect(record.bytes.length).to.be.at.most(16384);
            expect(record.body.data.deepLink).to.contain("/grids/watched?");
            expect(record.body.data.kind).to.equal("grid");
        }
        await f.evaluated(() => edit(first.source, "Hidden changed", "a", "hidden"));
        const third = { ...kanbanRule(), target: { ...kanbanRule().target, projectId: "third-project" } };
        await f.update([{ ...rule(), channels: { mcp: false, mobile: false } }, third]);
        await f.watching(["watch-kanban"]);
        await write(PROJECT, "MCP disabled");
        await write("third-project", "Third visible update");
        await waitFor(() => network.bodies.filter(record => record.body.name).length === 3, 15000);
        const changed = network.bodies.filter(record => record.body.name);
        expect(changed[2].body.data).to.include({
            projectId: "third-project",
            kind: "kanban",
            objectId: "board",
            ruleId: "watch-kanban",
        });
        expect(changed[2].headers["x-mcp-subscription-id"]).to.equal(registration.result.id);
        expect(network.bodies.filter(record => record.body.challenge)).to.have.length(1);
        expect(JSON.stringify(changed)).not.to.contain("SECRET").and.not.to.contain("Hidden changed").and.not.to
            .contain("MCP disabled").and.not.to.contain("SELECT");
        expect(events.status(UID).latestAttempt).to.equal("accepted");
        expect(events.status("different-owner")).to.deep.equal({
            state: "configured",
            expiresAtMs: undefined,
            latestAttempt: null,
        });
    });
});
