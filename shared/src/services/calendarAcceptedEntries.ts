import * as Y from "yjs";
import { Item, type Project } from "../app-schema.js";
import type { CalendarEntryRoles } from "./calendarEntries.js";
import { buildCalendarEntries, type CalendarEntry } from "./calendarEntries.js";
import { isRecurring } from "./calendarItemOccurrences.js";
import { isOutlineItemSourceKind, resolveOutlineItemId } from "./calendarSourceIdentity.js";

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

/** An Item wrapper alone can exist without a hydrated outline node. */
function hasRecurringSource(row: Record<string, unknown>, project?: Project): boolean {
    const string = (value: unknown) => value == null ? undefined : String(value);
    const sourceKind = string(row.source_kind);
    const rrule = string(row.rrule);
    if (!rrule || !isOutlineItemSourceKind(sourceKind)) return true;
    if (!project) return false;
    try {
        const tree = project.tree;
        // Use the same stable tree key projected as outline_items.id, not text
        // or the existence of an arbitrary supplied Project/Item wrapper.
        const hydrated = (key: string) => {
            const value = tree.getNodeValueFromKey(key);
            return value instanceof Y.Map && value.doc === project.ydoc && value.get("id") === key;
        };
        const sourceId = resolveOutlineItemId({ sourceKind, sourceId: string(row.source_id) }, hydrated);
        if (!sourceId) return false;
        const parent = tree.getNodeParentFromKey(sourceId);
        if (!parent || (parent !== "root" && !hydrated(parent))) return false;
        if (!tree.getNodeChildrenFromKey(parent).includes(sourceId)) return false;
        const item = new Item(project.ydoc, tree, sourceId);
        if (!isRecurring(item) || item.rrule?.trim() !== rrule) return false;
        // Queries need not select these structural columns; if selected they
        // must still identify the same accepted recurrence source/context.
        return (!("parent_id" in row) || string(row.parent_id) === (parent === "root" ? undefined : parent))
            && (!("recurrence_dtstart" in row) || string(row.recurrence_dtstart) === item.recurrenceDtstart?.trim())
            && (!("recurrence_timezone" in row) || string(row.recurrence_timezone) === item.recurrenceTimezone?.trim());
    } catch {
        return false;
    }
}

/**
 * Adapter from generation-checked query evidence to the production entry
 * model. Incomplete authoritative recurrence evidence cannot be compared as
 * a normal anchor row. The interactive builder retains its fallback behavior.
 */
export function deriveAcceptedCalendarEntries(
    evidence: AcceptedCalendarEntryEvidence,
): AcceptedCalendarEntriesResult {
    if (!evidence.current) {
        return { ready: false, reason: "Accepted Calendar SQL evidence is stale or unavailable." };
    }
    if (!evidence.result.rows.every(row => hasRecurringSource(row, evidence.project))) {
        return { ready: false, reason: "Calendar recurrence outline evidence is unavailable." };
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
