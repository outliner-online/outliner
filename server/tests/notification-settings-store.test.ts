import Database from "better-sqlite3";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NotificationSettingsService } from "../src/notifications/settings-service.js";
import { NotificationSettingsStore, NotificationSettingsStoreError } from "../src/notifications/settings-store.js";

describe("notification settings store", () => {
    const dir = mkdtempSync(join(tmpdir(), "notification-settings-"));
    const path = join(dir, "settings.sqlite");
    after(() => rmSync(dir, { recursive: true, force: true }));
    const rule = {
        ruleId: "rule-1",
        target: { projectId: "project-1", kind: "grid" as const, objectId: "grid-1" },
        enabled: true,
        channels: { mcp: true, mobile: false },
        context: { version: 1 as const, locale: "en-US", timeZone: "UTC", surface: "table" as const },
    };

    it("persists owner-isolated settings and revisions across restart", async () => {
        let db = new Database(path);
        let store = new NotificationSettingsStore(() => db);
        store.initialize();
        const service = new NotificationSettingsService(store, {
            assertTarget: async () => {},
            listTargets: async () => [],
        });
        const events: unknown[] = [];
        service.onCommittedChange(event => events.push(event));
        const result = await service.update("owner-a", { expectedRevision: 0, upsert: [rule], removeRuleIds: [] });
        expect(result.settings).to.deep.equal({ revision: 1, rules: [rule] });
        expect(service.get("owner-b")).to.deep.equal({ revision: 0, rules: [] });
        expect(events).to.deep.equal([{ uid: "owner-a", revision: 1 }]);
        db.close();
        db = new Database(path);
        store = new NotificationSettingsStore(() => db);
        store.initialize();
        expect(store.get("owner-a")).to.deep.equal({ revision: 1, rules: [rule] });
        expect(() => store.apply("owner-a", 0, [])).to.throw(NotificationSettingsStoreError);
        expect(store.get("owner-a").revision).to.equal(1);
        db.close();
    });

    it("keeps mixed-case identical updates and absent removals as signal-free no-ops", async () => {
        const db = new Database(":memory:");
        const store = new NotificationSettingsStore(() => db);
        const service = new NotificationSettingsService(store, {
            assertTarget: async () => {},
            listTargets: async () => [],
        });
        const upper = { ...rule, ruleId: "B", target: { ...rule.target, objectId: "upper" } };
        const lower = { ...rule, ruleId: "a", target: { ...rule.target, objectId: "lower" } };
        await service.update("owner", { expectedRevision: 0, upsert: [lower, upper], removeRuleIds: [] });
        const events: unknown[] = [];
        service.onCommittedChange(event => events.push(event));

        const identical = await service.update("owner", {
            expectedRevision: 1,
            upsert: [lower, upper],
            removeRuleIds: ["absent"],
        });

        expect(identical).to.deep.equal({
            applied: false,
            priorRevision: 1,
            settings: { revision: 1, rules: [upper, lower] },
        });
        expect(events).to.deep.equal([]);
        db.close();
    });
});
