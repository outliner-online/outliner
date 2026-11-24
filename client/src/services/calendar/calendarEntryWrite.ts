// Write dispatch for a calendar entry's drag/resize/keyboard move (#4347).
//
// Every edit goes through the relation's own write path — never PGlite
// directly (docs/crdt-sql-architecture.md §4) — addressed by the entry's
// `source_kind`/`source_id` (relationRowWrite.ts's `applyUnionedRowEdit`),
// exactly like a table's unioned-row edit.
//
// The write's *target column* is the underlying column
// `calendarColumnWritability.ts` resolved for the role — never the
// calendar query's own output alias, which may not exist on the source
// relation at all. This is also why a drag/resize never has to reconcile
// `start_on` vs. `start_at` itself: whichever one the query's `roleStart`
// column actually passes through is the one written, and `entry.allDay`
// (derived from that same resolved shape when the row was built) decides
// only how the value is formatted, not which column receives it.

import { utcMsToFloatingDate } from "$shared/utils/zonedTime";
import type { RelationResolver } from "../yjstable/relationRowWrite";
import { applyUnionedRowEdit } from "../yjstable/relationRowWrite";
import type { CalendarEntry } from "./calendarEntries";
import { msToIsoDuration } from "./pgInterval";

export { resolveCalendarEntryWritability } from "$shared/services/calendarEntries";
export type { CalendarEntryWritability } from "$shared/services/calendarEntries";

function requireOrigin(
    entry: Pick<CalendarEntry, "sourceKind" | "sourceId">,
): { sourceKind: string; sourceId: string; } {
    if (!entry.sourceKind || !entry.sourceId) {
        throw new Error("Entry has no writable origin (missing source_kind/source_id)");
    }
    return { sourceKind: entry.sourceKind, sourceId: entry.sourceId };
}

/**
 * Write a new start instant for `entry` through the relation named by
 * `writableStartColumn` (the resolved underlying column for the calendar's
 * `roleStart`, from `analyzeCalendarColumnWritability`).
 *
 * `timeZone` is the calendar's own (§6.5) and is what an all-day entry's
 * floating date is derived in — the exact inverse of how `buildCalendarEntries`
 * read it, so dropping an entry on a day cell writes back that day rather
 * than whatever day UTC happened to be on at that instant.
 */
export async function writeCalendarEntryStart(
    resolver: RelationResolver,
    entry: Pick<CalendarEntry, "sourceKind" | "sourceId" | "allDay">,
    writableStartColumn: string,
    newStartMs: number,
    timeZone: string,
): Promise<void> {
    const { sourceKind, sourceId } = requireOrigin(entry);
    const value = entry.allDay
        ? utcMsToFloatingDate(newStartMs, timeZone)
        : new Date(newStartMs).toISOString();
    await applyUnionedRowEdit(resolver, sourceKind, sourceId, writableStartColumn, value);
}

/** Write a new duration for `entry`, as the ISO 8601 text `Item.duration` stores. */
export async function writeCalendarEntryDuration(
    resolver: RelationResolver,
    entry: Pick<CalendarEntry, "sourceKind" | "sourceId">,
    writableDurationColumn: string,
    newDurationMs: number,
): Promise<void> {
    const { sourceKind, sourceId } = requireOrigin(entry);
    await applyUnionedRowEdit(resolver, sourceKind, sourceId, writableDurationColumn, msToIsoDuration(newDurationMs));
}
