import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeViewRange } from "$shared/services/calendarGridRange";
import * as Y from "yjs";
import { Items, Project } from "../../schema/app-schema";

export function groupedDayEvidence() {
    const project = Project.fromDoc(new Y.Doc());
    const page = new Items(project.ydoc, project.tree, "root").addNode("fixture");
    const source = new Items(project.ydoc, project.tree, page.key).addNode("fixture");
    source.text = "Recurring";
    source.start = "2026-03-16T00:00:00Z";
    source.allDay = false;
    source.duration = "PT30M";
    source.rrule = "FREQ=HOURLY;COUNT=2";
    source.recurrenceDtstart = "2026-03-16T09:00:00";
    source.recurrenceTimezone = "Asia/Tokyo";
    const anchorUtcMs = Date.parse("2026-03-16T00:00:00Z");
    const range = computeViewRange(anchorUtcMs, "day", 1, "Asia/Tokyo");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "Asia/Tokyo",
        weekStart: 1,
        viewType: "day",
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
    const row: Record<string, unknown> = {
        id: source.key,
        title: "Recurring",
        start: source.start,
        duration: source.duration,
        rrule: source.rrule,
        parent_id: page.key,
        team: '["Red","Blue"]',
        source_kind: "outline_items",
        source_id: source.key,
    };
    const input = {
        current: true,
        project,
        context,
        settings: {
            name: "Grouped Day",
            groupAxes: ["team", "unselected_deeper_axis"],
            laneOrder: ["Blue", "Empty", "Red"],
            showEmptyLanes: true,
            roleTitle: "title",
            roleStart: "start",
            roleDuration: "duration",
        },
        result: { columns: Object.keys(row), rows: [row] },
    };
    return { input, row, source, page };
}
