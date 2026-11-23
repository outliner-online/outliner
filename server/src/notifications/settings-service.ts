import type {
    NotificationRule,
    NotificationSettings,
    NotificationSettingsChange,
    NotificationTarget,
} from "../../../shared/src/notifications/notification-settings.js";
import { normalizeNotificationRule } from "../../../shared/src/notifications/notification-settings.js";
import { compareRuleIds, NotificationSettingsStore } from "./settings-store.js";

export interface NotificationTargetAuthority {
    assertTarget(uid: string, target: NotificationTarget): Promise<void>;
    listTargets(uid: string, projectId: string): Promise<NotificationTargetSummary[]>;
}
export interface NotificationTargetSummary {
    objectId: string;
    kind: "grid" | "calendar" | "kanban";
    name: string;
    contextShape: string;
}
export class NotificationSettingsService {
    private readonly listeners = new Set<(change: { uid: string; revision: number; }) => void>();
    constructor(readonly store: NotificationSettingsStore, private readonly authority: NotificationTargetAuthority) {}
    get(uid: string): NotificationSettings {
        return this.store.get(uid);
    }
    enabled(uid: string): NotificationRule[] {
        return this.store.enabled(uid);
    }
    async listTargets(uid: string, input: { projectId: string; limit: number; cursor?: string; }) {
        let offset = 0;
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
            throw new Error("limit must be 1..100");
        }
        if (input.cursor !== undefined) {
            try {
                offset = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as number;
            } catch {
                throw new Error("cursor is invalid");
            }
            if (!Number.isInteger(offset) || offset < 0) throw new Error("cursor is invalid");
        }
        const targets = await this.authority.listTargets(uid, input.projectId);
        const page = targets.slice(offset, offset + input.limit);
        const next = offset + page.length;
        return {
            projectId: input.projectId,
            targets: page,
            ...(next < targets.length ? { cursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
        };
    }
    async update(uid: string, change: NotificationSettingsChange) {
        if (
            !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0
            || !Array.isArray(change.upsert)
            || !Array.isArray(change.removeRuleIds)
        ) throw new Error("invalid settings change");
        const upsert = change.upsert.map(normalizeNotificationRule);
        const upsertIds = new Set(upsert.map(rule => rule.ruleId));
        const removes = new Set(change.removeRuleIds);
        if (
            upsertIds.size !== upsert.length || removes.size !== change.removeRuleIds.length
            || change.removeRuleIds.some(id => typeof id !== "string" || upsertIds.has(id))
        ) throw new Error("duplicate or conflicting rule operations");
        for (const rule of upsert) await this.authority.assertTarget(uid, rule.target);
        const byId = new Map(this.get(uid).rules.map(rule => [rule.ruleId, rule]));
        for (const id of removes) byId.delete(id);
        for (const rule of upsert) byId.set(rule.ruleId, rule);
        const rules = [...byId.values()].sort((a, b) => compareRuleIds(a.ruleId, b.ruleId));
        if (
            rules.length > 128
            || Buffer.byteLength(JSON.stringify({ revision: change.expectedRevision + 1, rules })) > 65536
        ) throw new Error("settings limits exceeded");
        const priorRevision = change.expectedRevision;
        const outcome = this.store.apply(uid, change.expectedRevision, rules);
        if (outcome.applied) {
            for (const listener of this.listeners) {
                try {
                    listener({ uid, revision: outcome.settings.revision });
                } catch { /* commit remains authoritative */ }
            }
        }
        return { applied: outcome.applied, priorRevision, settings: outcome.settings };
    }
    onCommittedChange(listener: (change: { uid: string; revision: number; }) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
