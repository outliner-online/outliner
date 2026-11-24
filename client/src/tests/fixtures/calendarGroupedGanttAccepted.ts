import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeGanttRange } from "$shared/services/calendarGridRange";

export function groupedGanttEvidence() {
    const anchorUtcMs = Date.parse("2026-04-01T04:00:00Z");
    const range = computeGanttRange(anchorUtcMs, "day", "America/New_York");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "gantt",
        ganttScale: "day",
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: ["outline_items:p"],
    };
    const row = (id: string, title: string, offset: number, team: unknown, sourceId = id) => ({
        id,
        title,
        start_value: new Date(anchorUtcMs + offset * 86_400_000).toISOString(),
        duration: "1 day",
        parent_id: "p",
        team,
        source_kind: "outline_items",
        source_id: sourceId,
    });
    const rows: Record<string, unknown>[] = [
        row("null", "Null", 1, null),
        row("outside", "Outside", 45, "B"),
        row("a", "Shared A", 6, "A", "p"),
        row("p", "Shared B", 20, "B"),
        row("json", "JSON", 23, '["Red","Blue"]'),
        row("empty", "Empty", 8, ""),
    ];
    return {
        current: true,
        context,
        result: { columns: Object.keys(rows[0]), rows },
        settings: {
            name: "Grouped Gantt",
            query:
                "SELECT id, title, start_value, duration, parent_id, team, source_kind, source_id FROM outline_items",
            roleTitle: "title",
            roleStart: "start_value",
            roleDuration: "duration",
            groupAxes: ["team", "ignored_deeper_axis"],
            laneOrder: ["Unused", "A", "B"],
            showEmptyLanes: true,
        },
    };
}
