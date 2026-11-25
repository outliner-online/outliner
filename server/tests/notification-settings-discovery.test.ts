import Database from "better-sqlite3";
import { expect } from "chai";
import type { NotificationRule } from "../../shared/src/notifications/notification-settings.js";
import { NotificationSettingsService } from "../src/notifications/settings-service.js";
import { NotificationSettingsStore } from "../src/notifications/settings-store.js";

describe("bounded notification rule discovery", () => {
    const rule = (ruleId: string, enabled = true): NotificationRule => ({
        ruleId,
        target: { projectId: "project", kind: "grid", objectId: "grid" },
        enabled,
        channels: { mcp: true, mobile: false },
        context: { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" },
    });

    it("pages across owners without omissions when a prior cursor row is removed", async () => {
        const db = new Database(":memory:");
        const store = new NotificationSettingsStore(() => db);
        const settings = new NotificationSettingsService(store, {
            assertTarget: async () => {},
            listTargets: async () => [],
        });
        try {
            for (const uid of ["owner-c", "owner-a", "owner-b"]) {
                await settings.update(uid, {
                    expectedRevision: 0,
                    upsert: [rule("B"), rule("a"), rule("off", false)],
                    removeRuleIds: [],
                });
            }
            const first = store.listEnabledPage({ limit: 2 });
            expect(first.entries.map(entry => [entry.uid, entry.rule.ruleId, entry.revision]))
                .to.deep.equal([["owner-a", "B", 1], ["owner-a", "a", 1]]);
            expect(first.cursor).to.deep.equal({ uid: "owner-a", ruleId: "a" });
            await settings.update("owner-a", { expectedRevision: 1, upsert: [], removeRuleIds: ["a"] });
            const second = store.listEnabledPage({ after: first.cursor, limit: 3 });
            expect(second.entries.map(entry => [entry.uid, entry.rule.ruleId]))
                .to.deep.equal([["owner-b", "B"], ["owner-b", "a"], ["owner-c", "B"]]);
            const final = store.listEnabledPage({ after: second.cursor, limit: 3 });
            expect(final.entries.map(entry => [entry.uid, entry.rule.ruleId])).to.deep.equal([["owner-c", "a"]]);
            expect(final.cursor).to.equal(undefined);
            expect(store.listEnabledPage({ limit: 128 }).entries).to.have.length(5);
        } finally {
            db.close();
        }
    });

    it("refuses discovery requests that exceed the finite page bound", () => {
        const db = new Database(":memory:");
        const store = new NotificationSettingsStore(() => db);
        try {
            for (const limit of [0, -1, 1.5, 129, Infinity, NaN]) {
                expect(() => store.listEnabledPage({ limit })).to.throw(RangeError);
            }
            expect(store.listEnabledPage({ limit: 1 })).to.deep.equal({ entries: [] });
        } finally {
            db.close();
        }
    });
});
