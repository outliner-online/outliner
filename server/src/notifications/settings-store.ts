import type Database from "better-sqlite3";
import type {
    NotificationRule,
    NotificationSettings,
} from "../../../shared/src/notifications/notification-settings.js";
import { normalizeNotificationRule } from "../../../shared/src/notifications/notification-settings.js";

export class NotificationSettingsStoreError extends Error {
    constructor(readonly code: "stale_revision" | "unavailable", message: string) {
        super(message);
    }
}
export class NotificationSettingsStore {
    private initializedDb?: Database.Database;
    constructor(private readonly database: () => Database.Database | undefined) {}
    initialize(): void {
        this.requireDb();
    }
    get(uid: string): NotificationSettings {
        const db = this.requireDb();
        try {
            const head = db.prepare("SELECT revision FROM notification_settings_heads WHERE uid=?").get(uid) as {
                revision: number;
            } | undefined;
            const rows = db.prepare("SELECT rule_json FROM notification_rules WHERE uid=?").all(uid) as {
                rule_json: string;
            }[];
            if (!Number.isSafeInteger(head?.revision ?? 0) || (head?.revision ?? 0) < 0) {
                throw new Error("invalid persisted revision");
            }
            const rules = rows.map(row => normalizeNotificationRule(JSON.parse(row.rule_json)))
                .sort((a, b) => compareRuleIds(a.ruleId, b.ruleId));
            return { revision: head?.revision ?? 0, rules };
        } catch (error) {
            throw unavailable(error);
        }
    }
    apply(
        uid: string,
        expectedRevision: number,
        rules: NotificationRule[],
    ): { applied: boolean; settings: NotificationSettings; } {
        const db = this.requireDb();
        try {
            return db.transaction(() => {
                const current = this.get(uid);
                if (current.revision !== expectedRevision) {
                    throw new NotificationSettingsStoreError("stale_revision", "settings revision is stale");
                }
                if (JSON.stringify(current.rules) === JSON.stringify(rules)) {
                    return { applied: false, settings: current };
                }
                const revision = current.revision + 1;
                db.prepare(
                    "INSERT INTO notification_settings_heads(uid,revision) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET revision=excluded.revision",
                ).run(uid, revision);
                db.prepare("DELETE FROM notification_rules WHERE uid=?").run(uid);
                const insert = db.prepare(
                    "INSERT INTO notification_rules(uid,rule_id,project_id,enabled,rule_json) VALUES(?,?,?,?,?)",
                );
                for (const rule of rules) {
                    insert.run(uid, rule.ruleId, rule.target.projectId, rule.enabled ? 1 : 0, JSON.stringify(rule));
                }
                return { applied: true, settings: { revision, rules } };
            })();
        } catch (error) {
            throw unavailable(error);
        }
    }
    enabled(uid: string): NotificationRule[] {
        return this.get(uid).rules.filter(rule => rule.enabled);
    }
    private requireDb(): Database.Database {
        const db = this.database();
        if (!db?.open) {
            throw new NotificationSettingsStoreError("unavailable", "notification settings storage is unavailable");
        }
        if (this.initializedDb !== db) {
            try {
                db.exec(
                    `CREATE TABLE IF NOT EXISTS notification_settings_heads(uid TEXT PRIMARY KEY, revision INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS notification_rules(uid TEXT NOT NULL, rule_id TEXT NOT NULL, project_id TEXT NOT NULL,
              enabled INTEGER NOT NULL, rule_json TEXT NOT NULL, PRIMARY KEY(uid, rule_id));
              CREATE INDEX IF NOT EXISTS notification_rules_project ON notification_rules(project_id);`,
                );
            } catch (error) {
                throw unavailable(error);
            }
            this.initializedDb = db;
        }
        return db;
    }
}

function unavailable(error: unknown): NotificationSettingsStoreError {
    return error instanceof NotificationSettingsStoreError
        ? error
        : new NotificationSettingsStoreError("unavailable", "notification settings storage is unavailable");
}

/** SQLite and service comparisons must share one locale-independent canonical order. */
export function compareRuleIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
