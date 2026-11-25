import Database from "better-sqlite3";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialEnvelope } from "../src/notifications/credential-envelope.js";
import { callbackIdentity } from "../src/notifications/mcp-events-protocol.js";
import { McpLeaseStore } from "../src/notifications/mcp-lease-store.js";
import { KEY, SECRET, URL } from "./mcp-events-fixture.js";

const input = () => ({
    uid: "owner",
    clientId: "chatgpt",
    identity: callbackIdentity("chatgpt", URL),
    callbackUrl: URL,
    signingSecret: SECRET,
    expiresAtMs: Date.now() + 60000,
});
describe("private SQLite account lease authority", () => {
    let db: Database.Database;
    let store: McpLeaseStore;
    beforeEach(() => {
        db = new Database(":memory:");
        store = new McpLeaseStore(() => db, new CredentialEnvelope(KEY));
    });
    afterEach(() => {
        if (db.open) db.close();
    });
    it("encrypts credentials with authenticated owner/identity/envelope context and refuses tampering", () => {
        const lease = store.commit(store.reserve(input()));
        const rows = db.prepare("SELECT * FROM notification_mcp_leases").all();
        expect(JSON.stringify(rows)).not.to.contain(URL).and.not.to.contain(SECRET);
        expect(store.capture("owner")).to.deep.equal(lease);
        db.prepare("UPDATE notification_mcp_leases SET uid='other'").run();
        expect(() => store.capture("other")).to.throw("unavailable");
        expect(() => new CredentialEnvelope("invalid")).to.throw("unavailable");
    });
    it("fences superseded, unsubscribed and expired candidates while retaining an old lease on refresh failure", async () => {
        const active = store.commit(store.reserve(input()));
        const failed = store.reserve(input());
        store.fail(failed);
        expect(store.isCurrent(active)).to.equal(true);
        const first = store.reserve(input());
        const second = store.reserve(input());
        expect(() => store.commit(first)).to.throw("expired");
        const renewed = store.commit(second);
        expect(renewed.generation).to.be.greaterThan(active.generation);
        expect(store.isCurrent(active)).to.equal(false);
        store.gone(active);
        expect(store.isCurrent(renewed)).to.equal(true);
        const removed = store.reserve(input());
        store.remove("owner", renewed.identity);
        expect(() => store.commit(removed)).to.throw("expired");
        expect(store.capture("owner")).to.equal(undefined);
        const expired = store.reserve({ ...input(), expiresAtMs: Date.now() + 20 });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(() => store.commit(expired)).to.throw("expired");
        expect(db.prepare("SELECT active,pending FROM notification_mcp_leases").get()).to.deep.equal({
            active: null,
            pending: null,
        });
    });
    it("clears expired credentials, refuses closed storage, and atomically rolls back a refused activation", async () => {
        const candidate = store.reserve(input());
        db.exec(
            "CREATE TRIGGER refuse_activation BEFORE UPDATE OF active ON notification_mcp_leases BEGIN SELECT RAISE(ABORT,'private detail'); END",
        );
        expect(() => store.commit(candidate)).to.throw("Notification Events unavailable");
        expect(db.prepare("SELECT active FROM notification_mcp_leases").get()).to.deep.equal({ active: null });
        db.exec("DROP TRIGGER refuse_activation");
        const lease = store.commit(store.reserve({ ...input(), expiresAtMs: Date.now() + 20 }));
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(store.isCurrent(lease)).to.equal(false);
        expect(store.status("owner").state).to.equal("expired");
        expect(db.prepare("SELECT active,pending FROM notification_mcp_leases").get()).to.deep.equal({
            active: null,
            pending: null,
        });
        db.close();
        expect(store.ready()).to.equal(false);
        expect(() => store.reserve(input())).to.throw("unavailable");
    });
    it("reconstructs only unexpired active state on disk and invalidates unfinished challenges", () => {
        const directory = mkdtempSync(join(tmpdir(), "events-lease-"));
        const path = join(directory, "private.sqlite");
        let disk = new Database(path);
        try {
            let durable = new McpLeaseStore(() => disk, new CredentialEnvelope(KEY));
            const active = durable.commit(durable.reserve(input()));
            const pending = durable.reserve(input());
            disk.close();
            disk = new Database(path);
            durable = new McpLeaseStore(() => disk, new CredentialEnvelope(KEY));
            const restored = durable.capture("owner")!;
            expect(restored.subscriptionId).to.equal(active.subscriptionId);
            expect(restored.generation).to.be.greaterThan(active.generation);
            expect(() => durable.commit(pending)).to.throw("expired");
            expect(durable.status("owner").state).to.equal("active");
            const wrongKey = new McpLeaseStore(() => disk,
                new CredentialEnvelope(Buffer.alloc(32, 9).toString("base64")));
            expect(() => wrongKey.capture("owner")).to.throw("unavailable");
            expect(disk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).to.deep.equal([{
                name: "notification_mcp_leases",
            }]);
        } finally {
            if (disk.open) disk.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
