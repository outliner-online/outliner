import { computeGanttRange, computeViewRange, type GanttScale } from "../services/calendarGridRange.js";

export const CALENDAR_OBSERVATION_CONTEXT_VERSION = 1 as const;
export type CalendarObservationViewType = "day" | "hours" | "days" | "week" | "month" | "gantt";

export interface CalendarObservationContextV1 {
    readonly version: 1;
    readonly locale: string;
    readonly timeZone: string;
    readonly weekStart: number;
    readonly viewType: CalendarObservationViewType;
    readonly anchorUtcMs: number;
    readonly rangeStartUtcMs: number;
    readonly rangeEndUtcMs: number;
    readonly monthLaneFilter: string | null;
    readonly collapsedEntryKeys: readonly string[];
    readonly ganttScale?: GanttScale;
}

export type CalendarContextValidationResult =
    | { readonly valid: true; readonly context: CalendarObservationContextV1; }
    | { readonly valid: false; readonly error: string; };

const VIEW_TYPES = new Set<CalendarObservationViewType>(["day", "hours", "days", "week", "month", "gantt"]);
const GANTT_SCALES = new Set<GanttScale>(["day", "week", "month", "quarter"]);

/** Validate and canonicalize an untrusted context without consulting browser state or live Calendar data. */
export function validateCalendarObservationContext(value: unknown): CalendarContextValidationResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Context must be an object.");
    const input = value as Record<string, unknown>;
    if (input.version !== 1) return invalid("Unsupported Calendar observation context version.");
    if (typeof input.locale !== "string") return invalid("Locale is required.");
    let locale: string;
    try {
        locale = Intl.getCanonicalLocales(input.locale)[0];
        if (!locale) return invalid("Locale is unsupported.");
        const resolvedLocale = new Intl.DateTimeFormat(locale).resolvedOptions().locale;
        // Intl accepts structurally valid but unavailable locales by silently
        // falling back to the host default. That fallback is not authoritative
        // enough for a saved observation context.
        if (Intl.getCanonicalLocales(resolvedLocale)[0] !== locale) return invalid("Locale is unsupported.");
    } catch {
        return invalid("Locale is unsupported.");
    }
    if (typeof input.timeZone !== "string") return invalid("Time zone is required.");
    let timeZone: string;
    try {
        timeZone = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).resolvedOptions().timeZone;
    } catch {
        return invalid("Time zone is unsupported.");
    }
    if (!Number.isInteger(input.weekStart) || (input.weekStart as number) < 0 || (input.weekStart as number) > 6) {
        return invalid("weekStart must be an integer from 0 through 6.");
    }
    if (typeof input.viewType !== "string" || !VIEW_TYPES.has(input.viewType as CalendarObservationViewType)) {
        return invalid("Calendar view type is unsupported.");
    }
    for (const field of ["anchorUtcMs", "rangeStartUtcMs", "rangeEndUtcMs"] as const) {
        if (
            typeof input[field] !== "number"
            || !Number.isFinite(input[field])
            || !Number.isSafeInteger(input[field])
            || !Number.isFinite(new Date(input[field]).getTime())
        ) {
            return invalid(`${field} must be a representable finite epoch.`);
        }
    }
    const viewType = input.viewType as CalendarObservationViewType;
    const ganttScale = input.ganttScale;
    if (viewType === "gantt") {
        if (typeof ganttScale !== "string" || !GANTT_SCALES.has(ganttScale as GanttScale)) {
            return invalid("Gantt context requires a supported ganttScale.");
        }
    } else if (ganttScale !== undefined) return invalid("ganttScale is only valid in Gantt mode.");
    if (input.monthLaneFilter !== null && typeof input.monthLaneFilter !== "string") {
        return invalid("monthLaneFilter must be a string or null.");
    }
    if (viewType !== "month" && input.monthLaneFilter !== null) {
        return invalid("monthLaneFilter must be null outside month mode.");
    }
    if (!Array.isArray(input.collapsedEntryKeys) || input.collapsedEntryKeys.some((key) => typeof key !== "string")) {
        return invalid("collapsedEntryKeys must be an array of strings.");
    }
    if (viewType !== "gantt" && input.collapsedEntryKeys.length !== 0) {
        return invalid("collapsedEntryKeys must be empty outside Gantt mode.");
    }
    let expected: { start: number; end: number; };
    try {
        expected = viewType === "gantt"
            ? computeGanttRange(input.anchorUtcMs as number, ganttScale as GanttScale, timeZone)
            : computeViewRange(input.anchorUtcMs as number, viewType, input.weekStart as number, timeZone);
    } catch {
        return invalid("Calendar range cannot be derived from the supplied context.");
    }
    if (
        !Number.isFinite(new Date(expected.start).getTime())
        || !Number.isFinite(new Date(expected.end).getTime())
    ) return invalid("Calendar range is outside the representable date range.");
    if (expected.start !== input.rangeStartUtcMs || expected.end !== input.rangeEndUtcMs) {
        return invalid("Calendar range is not coherent with its anchor and view settings.");
    }
    return {
        valid: true,
        context: Object.freeze({
            version: 1,
            locale,
            timeZone,
            weekStart: input.weekStart as number,
            viewType,
            anchorUtcMs: input.anchorUtcMs as number,
            rangeStartUtcMs: input.rangeStartUtcMs as number,
            rangeEndUtcMs: input.rangeEndUtcMs as number,
            monthLaneFilter: input.monthLaneFilter as string | null,
            collapsedEntryKeys: Object.freeze([...(input.collapsedEntryKeys as string[])]),
            ...(viewType === "gantt" ? { ganttScale: ganttScale as GanttScale } : {}),
        }),
    };
}

function invalid(error: string): CalendarContextValidationResult {
    return { valid: false, error };
}

export function encodeCalendarObservationContext(context: CalendarObservationContextV1): string {
    const result = validateCalendarObservationContext(context);
    if (result.valid === false) throw new Error(result.error);
    return JSON.stringify(result.context);
}

export function decodeCalendarObservationContext(encoded: string): CalendarContextValidationResult {
    try {
        return validateCalendarObservationContext(JSON.parse(encoded));
    } catch {
        return invalid("Calendar observation context is malformed.");
    }
}

/** Browser-independent, equality-ready semantics produced by the same Calendar layout path as the UI. */
export interface CalendarVisibleProjection {
    readonly version: 1;
    readonly title: string;
    readonly rangeLabel: string;
    readonly modeLabel: string;
    readonly labels: readonly string[];
    readonly content: readonly Readonly<Record<string, string | number | boolean | null>>[];
}

export type CalendarProjectionResult =
    | { readonly ready: true; readonly projection: CalendarVisibleProjection; }
    | { readonly ready: false; readonly reason: string; };

/**
 * Freezes complete production-derived visible semantics for comparison. Callers must refuse to invoke this
 * until accepted SQL results, committed settings, recurrence inputs, and layout output belong to one revision.
 * Serialization primitive only: authoritative callers use deriveCalendarVisibleModel with structural evidence.
 */
export function projectCalendarVisibleState(
    contextValue: unknown,
    visible: Omit<CalendarVisibleProjection, "version"> | undefined,
): CalendarProjectionResult {
    const context = validateCalendarObservationContext(contextValue);
    if (context.valid === false) return { ready: false, reason: context.error };
    if (!visible) return { ready: false, reason: "Authoritative Calendar visible-state evidence is unavailable." };
    const content = visible.content.map(item => Object.freeze({ ...item }));
    return {
        ready: true,
        projection: Object.freeze({
            version: 1,
            title: visible.title,
            rangeLabel: visible.rangeLabel,
            modeLabel: visible.modeLabel,
            labels: Object.freeze([...visible.labels]),
            content: Object.freeze(content),
        }),
    };
}
