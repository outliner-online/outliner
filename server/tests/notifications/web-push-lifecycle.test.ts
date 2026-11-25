import { expect } from "chai";
import * as Y from "yjs";
import { deferred, edit, PROJECT, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush } from "./web-push-crypto.fixture.js";
import { mobileRule, type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("Web Push transient opportunities and lifetime", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    afterEach(async () => f?.close());

    it("settles a missing destination once and sends only a later visible change after enrollment", async () => {
        f = await webPushFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.settlements).to.deep.equal([{ initiated: false, outcome: "no_destination" }]);
        const receiver = await f.enroll();
        await f.evaluated(() => edit(source, "SECRET-later", "a", "hidden"));
        expect(f.settlements).to.have.length(1);
        expect(f.captured.calls).to.have.length(0);
        edit(source, "C");
        await waitFor(() => f.settlements.length === 2, 20_000);
        expect(f.captured.requests).to.have.length(1);
        expect(decryptPush(f.captured.requests[0], receiver).payload.body).to.contain("C");
    });

    it("drops an unsent opportunity across a process restart while retaining configuration", async () => {
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
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await reached.promise;
        expect(f.captured.requests).to.have.length(0);
        const old = f;
        const directory = f.directory, config = f.config;
        const db = f.server.persistence!.db!;
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'notification_%' OR name LIKE 'web_push_%') ORDER BY name",
        ).all();
        expect(tables).to.deep.equal([
            { name: "notification_rules" },
            { name: "notification_settings_heads" },
            { name: "web_push_admissions" },
            { name: "web_push_devices" },
            { name: "web_push_owners" },
        ]);
        const settings = JSON.stringify(db.prepare("SELECT * FROM notification_rules").all());
        expect(settings).not.to.contain("eventId").and.not.contain("sourceVersionToken").and.not.contain("summary");
        await f.close();
        resume.resolve();
        await waitFor(() => old.captured.outcomes.length === 1);
        expect(old.captured.outcomes[0].writeInitiated).to.equal(false);
        f = await webPushFixture({ directory, config });
        f.runtime.start();
        await f.watching(["watch-grid"]);
        expect(f.settlements).to.have.length(0);
        expect(f.captured.calls).to.have.length(0);
        expect(f.server.notificationSettings.get(UID).rules).to.deep.equal([mobileRule()]);
        expect(f.store.get(UID, receiver.deviceId)).to.include({ revision: receiver.revision, state: "registered" });
        const connection = await f.server.hocuspocus.openDirectConnection(`projects/${PROJECT}/tables/tasks`, {
            context: { uid: UID },
        });
        f.connections.push(connection);
        const restored = connection.document as unknown as Y.Doc;
        expect(restored.getMap<Y.Map<unknown>>("data").get("a")!.get("title")).to.equal("B");
        edit(restored, "C");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.captured.requests).to.have.length(1);
        expect(decryptPush(f.captured.requests[0], receiver).payload.body).to.contain("C");
        expect(old.captured.requests).to.have.length(0);
    });

    it("aborts pending requests on close and rejects a stale provider completion", async () => {
        const response = deferred();
        f = await webPushFixture({
            transportControls: {
                response: async () => {
                    await response.promise;
                    return 410;
                },
            },
        });
        const receiver = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.captured.requests.length === 1, 20_000);
        f.adapter.close();
        response.resolve();
        await waitFor(() => f.captured.outcomes.length === 1);
        expect(f.captured.outcomes[0]).to.include({ kind: "unknown", writeInitiated: true });
        expect(f.store.get(UID, receiver.deviceId)).to.include({ revision: receiver.revision, state: "registered" });
        expect(f.settlements).to.have.length(0);
        await waitFor(() => f.runtime.diagnostics().candidates === 0);
        edit(source, "C");
        await f.evaluated(() => edit(source, "SECRET-close", "a", "hidden"));
        expect(f.captured.requests).to.have.length(1);
    });
});
