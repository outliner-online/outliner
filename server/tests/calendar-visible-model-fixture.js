import * as Y from "yjs";
import { Items, Project } from "../dist/shared/src/app-schema.js";
export const modes = ["day", "hours", "days", "week", "month", "gantt"];
// Literal New York DST boundaries; Month includes the native padded week ending April 5.
const ranges = {
    day: ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    hours: ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    days: ["2026-03-08T05:00:00Z", "2026-03-11T04:00:00Z"],
    week: ["2026-03-08T05:00:00Z", "2026-03-15T04:00:00Z"],
    month: ["2026-03-01T05:00:00Z", "2026-04-05T04:00:00Z"],
    gantt: ["2026-03-08T05:00:00Z", "2026-04-07T04:00:00Z"],
};
export function calendarInput(viewType = "day", recurring = false) {
    const project = Project.fromDoc(new Y.Doc());
    const page = new Items(project.ydoc, project.tree, "root").addNode("runtime-fixture");
    const source = new Items(project.ydoc, project.tree, page.key).addNode("runtime-fixture");
    source.text = "Outline title differs from SQL";
    source.start = "2026-03-08T13:00:00Z";
    source.duration = "PT30M";
    source.allDay = false;
    if (recurring) {
        source.rrule = "FREQ=HOURLY;COUNT=2";
        source.recurrenceDtstart = "2026-03-08T09:00:00";
        source.recurrenceTimezone = "America/New_York";
    }
    const row = {
        id: source.key,
        parent_id: page.key,
        title: "Accepted SQL title",
        start: source.start,
        duration: source.duration,
        team: "A",
        source_kind: "outline_items",
        source_id: source.key,
        rrule: source.rrule ?? null,
    };
    const input = {
        authority: { current: true, project, result: { columns: Object.keys(row), rows: [row] } },
        settings: {
            name: "Authorized Calendar",
            query: "SELECT id, parent_id, text AS title, start_at AS start, duration, tags AS team, "
                + "'outline_items' AS source_kind, id AS source_id, rrule FROM outline_items",
            groupAxes: [],
            roleTitle: "title",
            roleStart: "start",
            roleDuration: "duration",
        },
        context: {
            version: 1,
            locale: "en-US",
            timeZone: "America/New_York",
            weekStart: 0,
            viewType,
            anchorUtcMs: Date.parse("2026-03-08T16:00:00Z"),
            rangeStartUtcMs: Date.parse(ranges[viewType][0]),
            rangeEndUtcMs: Date.parse(ranges[viewType][1]),
            monthLaneFilter: null,
            collapsedEntryKeys: [],
            ...(viewType === "gantt" ? { ganttScale: "day" } : {}),
        },
    };
    return { input, source, page, row };
}
