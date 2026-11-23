import { type CalendarObservationContextV1, validateCalendarObservationContext } from "./calendarProjection.js";

export type NotificationTargetKind = "grid" | "calendar" | "kanban";
export interface NotificationTarget {
    projectId: string;
    kind: NotificationTargetKind;
    objectId: string;
}
export interface GridObserverContext {
    version: 1;
    locale: string;
    timeZone: string;
    surface: "table";
}
export interface KanbanObserverContext {
    version: 1;
    locale: string;
    timeZone: string;
    surface: "board";
}
export type NotificationObserverContext = GridObserverContext | KanbanObserverContext | CalendarObservationContextV1;
export interface NotificationRule {
    ruleId: string;
    target: NotificationTarget;
    enabled: boolean;
    channels: { mcp: boolean; mobile: boolean; };
    context: NotificationObserverContext;
}
export interface NotificationSettings {
    revision: number;
    rules: NotificationRule[];
}
export interface NotificationSettingsChange {
    expectedRevision: number;
    upsert: NotificationRule[];
    removeRuleIds: string[];
}

const KEYS = {
    rule: ["ruleId", "target", "enabled", "channels", "context"],
    target: ["projectId", "kind", "objectId"],
    channels: ["mcp", "mobile"],
    simple: ["version", "locale", "timeZone", "surface"],
    calendar: ["version", "locale", "timeZone", "weekStart", "viewType", "rangeStartUtcMs", "rangeEndUtcMs",
        "anchorUtcMs", "monthLaneFilter", "collapsedEntryKeys", "ganttScale"],
} as const;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).every(key => keys.includes(key))
    && keys.filter(k => k !== "ganttScale").every(key => key in value);
const canonicalLocale = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("locale is required");
    const canonical = Intl.getCanonicalLocales(value)[0];
    if (
        !canonical
        || Intl.getCanonicalLocales(new Intl.DateTimeFormat(canonical).resolvedOptions().locale)[0] !== canonical
    ) {
        throw new Error("unsupported locale");
    }
    return canonical;
};
const canonicalZone = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("timeZone is required");
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return canonical;
};
const object = (value: unknown, message: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
    return value as Record<string, unknown>;
};

/** Strictly normalize the public rule DTO; no browser defaults participate. */
export function normalizeNotificationRule(value: unknown): NotificationRule {
    const rule = object(value, "rule must be an object");
    if (!exact(rule, KEYS.rule)) throw new Error("rule contains unknown or missing fields");
    const target = object(rule.target, "target must be an object");
    const channels = object(rule.channels, "channels must be an object");
    if (!exact(target, KEYS.target) || !exact(channels, KEYS.channels)) {
        throw new Error("target or channels fields are invalid");
    }
    const id = (v: unknown, name: string) => {
        if (typeof v !== "string" || v.length < 1 || v.length > 200) throw new Error(`${name} is invalid`);
        return v;
    };
    const kind = target.kind;
    if (kind !== "grid" && kind !== "calendar" && kind !== "kanban") throw new Error("target kind is unsupported");
    if (
        typeof rule.enabled !== "boolean" || typeof channels.mcp !== "boolean"
        || typeof channels.mobile !== "boolean"
    ) {
        throw new Error("rule flags must be Boolean");
    }
    const rawContext = object(rule.context, "context must be an object");
    let context: NotificationObserverContext;
    if (kind === "calendar") {
        if (!exact(rawContext, KEYS.calendar)) throw new Error("calendar context contains unknown or missing fields");
        const validated = validateCalendarObservationContext(rawContext);
        if (!validated.valid) throw new Error(validated.error);
        if (
            new Set(validated.context.collapsedEntryKeys).size !== validated.context.collapsedEntryKeys.length
            || validated.context.collapsedEntryKeys.length > 128
            || validated.context.collapsedEntryKeys.some(key => key.length > 200)
        ) throw new Error("collapsedEntryKeys is invalid");
        context = validated.context;
    } else {
        if (
            !exact(rawContext, KEYS.simple) || rawContext.version !== 1
            || rawContext.surface !== (kind === "grid" ? "table" : "board")
        ) throw new Error("observer context is invalid");
        context = {
            version: 1,
            locale: canonicalLocale(rawContext.locale),
            timeZone: canonicalZone(rawContext.timeZone),
            surface: kind === "grid" ? "table" : "board",
        };
    }
    return {
        ruleId: id(rule.ruleId, "ruleId"),
        target: { projectId: id(target.projectId, "projectId"), kind, objectId: id(target.objectId, "objectId") },
        enabled: rule.enabled,
        channels: { mcp: channels.mcp, mobile: channels.mobile },
        context,
    };
}
