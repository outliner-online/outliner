import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeViewRange } from "$shared/services/calendarGridRange";

export function monthEvidence() {
    const anchorUtcMs = Date.parse("2026-04-15T12:00:00Z");
    const range = computeViewRange(anchorUtcMs, "month", 1, "America/New_York");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "month",
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: "Red",
        collapsedEntryKeys: [],
    };
    const rows: Record<string, unknown>[] = [
        {
            id: "r",
            title: "Red entry",
            start_value: "2026-04-01T03:30:00Z",
            duration: "00:30:00",
            team: "Red",
            source_kind: "outline_items",
            source_id: "r",
        },
        {
            id: "b",
            title: "Hidden blue",
            start_value: "2026-04-01T12:00:00Z",
            duration: "00:30:00",
            team: "Blue",
            source_kind: "outline_items",
            source_id: "b",
        },
    ];
    return {
        current: true,
        context,
        result: { columns: Object.keys(rows[0]), rows },
        settings: {
            name: "Month",
            query: "SELECT id, title, start_value, duration, team, source_kind, source_id FROM outline_items",
            roleTitle: "title",
            roleStart: "start_value",
            roleDuration: "duration",
            groupAxes: ["team"],
            laneOrder: ["Red", "Empty", "Blue"],
            showEmptyLanes: true,
        },
    };
}
