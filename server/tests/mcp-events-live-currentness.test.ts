import { expect } from "chai";
import * as Y from "yjs";
import { type DirectConnection, releaseWithoutStore } from "../src/mcp/live-room.js";
import { CredentialEnvelope } from "../src/notifications/credential-envelope.js";
import { NotificationEventsService } from "../src/notifications/mcp-events-service.js";
import { McpLeaseStore } from "../src/notifications/mcp-lease-store.js";
import { held, KEY, mount, receiver, rpc, subscription, token } from "./mcp-events-fixture.js";
import {
    edit,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./notifications/observation-runtime.fixture.js";

describe("live observer authority after delayed connection", function() {
    this.timeout(60000);
    let f: RuntimeFixture;
    let events: NotificationEventsService;
    let network: ReturnType<typeof receiver>;
    beforeEach(async () => {
        f = await runtimeFixture({}, {}, undefined, false);
        await f.seed();
        network = receiver();
        events = new NotificationEventsService(
            new McpLeaseStore(() => f.server.persistence!.db, new CredentialEnvelope(KEY)),
            f.runtime,
            network.sender,
        );
        await rpc(mount(events), "events/subscribe", subscription, token(UID));
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
    });
    afterEach(async () => {
        await events?.close();
        await f?.close();
    });
    const write = (f: RuntimeFixture, title: string) => f.call("write_relation", {
        projectId: PROJECT,
        relation: "tasks",
        write: { op: "UPDATE", rowId: "a", column: "title", value: title },
    });
    for (const change of ["rule", "acl", "incarnation"] as const) {
        it(`refuses old A-to-B after ${change} authority is invalidated`, async () => {
            const gate = held();
            let entered = false;
            network.beforeTls = () => {
                entered = true;
                return gate.promise;
            };
            await write(f, "B");
            await waitFor(() => entered, 15000);
            if (change === "rule") await f.update([], ["watch-grid"]);
            else if (change === "acl") f.acl.revokeAll(PROJECT);
            else {
                const room = `projects/${PROJECT}/tables/tasks`;
                const saved = Y.encodeStateAsUpdate(f.connections[1].document as unknown as Y.Doc);
                releaseWithoutStore(f.connections[1] as unknown as DirectConnection);
                f.server.hocuspocus.documents.delete(room);
                const replacement = await f.server.hocuspocus.openDirectConnection(room, { context: { uid: UID } });
                f.connections[1] = replacement;
                Y.applyUpdate(replacement.document as unknown as Y.Doc, saved);
            }
            network.beforeTls = undefined;
            gate.resolve();
            await waitFor(() => events.status(UID).latestAttempt !== null, 15000);
            expect(network.bodies.filter(record => record.body.name)).to.have.length(0);
            expect(events.status(UID).latestAttempt).to.be.oneOf(["cancelled", "deferred"]);
        });
    }
    it("discards A-to-B and lets the runtime prepare separate current A-to-C semantics", async () => {
        const gate = held();
        let entered = false;
        network.beforeTls = () => {
            entered = true;
            return gate.promise;
        };
        await write(f, "B");
        await waitFor(() => entered, 15000);
        edit(f.connections[1].document as unknown as Y.Doc, "C");
        network.beforeTls = undefined;
        gate.resolve();
        await waitFor(() => network.bodies.some(record => record.body.name), 15000);
        const records = network.bodies.filter(record => record.body.name);
        expect(records).to.have.length(1);
        expect(records[0].body.data.samples[0].oldDisplay).to.contain("A");
        expect(records[0].body.data.samples[0].newDisplay).to.contain("C");
        expect(JSON.stringify(records[0].body)).not.to.contain("title: B");
    });
});
