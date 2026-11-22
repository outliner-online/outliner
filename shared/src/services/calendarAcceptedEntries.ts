import type { Project } from "../app-schema.js";
import type { CalendarEntryRoles } from "./calendarEntries.js";
import { buildCalendarEntries, type CalendarEntry } from "./calendarEntries.js";

export interface CalendarQueryRows {
    columns: string[];
    rows: Record<string, unknown>[];
}

export type AcceptedCalendarEntriesResult =
    | { readonly ready: true; readonly entries: CalendarEntry[]; }
    | { readonly ready: false; readonly reason: string; };

export interface AcceptedCalendarEntryEvidence {
    readonly current: boolean;
    readonly result: CalendarQueryRows;
    readonly settings: CalendarEntryRoles;
    readonly timeZone: string;
    readonly range: { readonly startUtcMs: number; readonly endUtcMs: number; };
    readonly project?: Project;
}

/**
 * Adapter from generation-checked query evidence to the production entry
 * model. `buildCalendarEntries` remains the sole Yjs recurrence/override
 * reader; stale SQL evidence is rejected before any entries are derived.
 */
export function deriveAcceptedCalendarEntries(
    evidence: AcceptedCalendarEntryEvidence,
): AcceptedCalendarEntriesResult {
    if (!evidence.current) {
        return { ready: false, reason: "Accepted Calendar SQL evidence is stale or unavailable." };
    }
    return {
        ready: true,
        entries: buildCalendarEntries(
            evidence.result,
            evidence.settings,
            evidence.timeZone,
            evidence.project,
            evidence.range,
        ),
    };
}
