import { Item, Items } from "../../../shared/src/app-schema";
import type { CalendarObservationContextV1 } from "../../../shared/src/notifications/calendarProjection";
import { computeGanttRange, computeViewRange } from "../../../shared/src/services/calendarGridRange";
import { calendarProject } from "./calendarRouteFixture";

export function savedModeContext(viewType: "month" | "gantt"): CalendarObservationContextV1 {
    const anchorUtcMs = Date.parse(viewType === "month" ? "2026-04-08T12:00:00Z" : "2026-04-01T12:00:00Z");
    const range = viewType === "gantt"
        ? computeGanttRange(anchorUtcMs, "day", "America/New_York")
        : computeViewRange(anchorUtcMs, "month", 1, "America/New_York");
    return {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
        ...(viewType === "gantt" ? { ganttScale: "day" as const } : {}),
    };
}

export function savedModeProject(mode: "month" | "gantt") {
    const projectId = `saved-${mode}`;
    const calendarId = `${mode}-exact`;
    const name = mode === "month" ? "Saved Month" : "Saved Gantt";
    const prefix = mode === "month" ? "Month" : "Gantt";
    const target = calendarProject(projectId, `Saved ${mode} project`, calendarId, name);
    const first = new Item(target.doc, target.project.tree, target.itemId);
    const page = target.project.tree.getNodeParentFromKey(first.key)!;
    const entry = (parent: string, text: string, start: string, duration: string, tags: string[] = []) => {
        const value = new Items(target.doc, target.project.tree, parent).addNode("fixture");
        value.text = text;
        value.start = start;
        value.duration = duration;
        value.allDay = false;
        value.tags = tags;
        return value;
    };
    first.text = mode === "month" ? "Month Red visible" : "Gantt Parent";
    first.start = mode === "month" ? "2026-04-08T13:00:00Z" : "2026-04-02T13:00:00Z";
    first.duration = mode === "month" ? "PT30M" : "P1D";
    first.tags = mode === "month" ? ["Red"] : [];
    const other = mode === "month"
        ? entry(page, "Month Blue hidden", "2026-04-09T16:00:00Z", "PT30M", ["Blue"])
        : entry(first.key, "Gantt hidden child", "2026-04-04T13:00:00Z", "P2D");
    const secondChild = mode === "gantt"
        ? entry(first.key, "Gantt hidden second", "2026-04-07T13:00:00Z", "P1D")
        : undefined;
    const decoy = entry(page, "Decoy wrong Calendar entry", "2026-04-08T13:00:00Z", "PT30M", ["Red"]);
    const query = (rowPrefix: string) =>
        "SELECT id AS id, parent_id AS parent_id, "
        + "text || ' @ ' || current_setting('TimeZone') || ' [' || current_setting('view.range_start') || ',' || "
        + "current_setting('view.range_end') || ']' AS title, all_day AS all_day, start_at AS start_at, "
        + "duration AS duration, tags AS team, 'item' AS source_kind, id AS source_id "
        + `FROM outline_items WHERE text LIKE '${rowPrefix} %'`;
    const calendar = target.project.calendars.get(calendarId)!;
    calendar.set("query", query(prefix));
    calendar.set("viewType", mode === "month" ? "week" : "month");
    calendar.set("timezone", "Asia/Tokyo");
    calendar.set("weekStart", 0);
    calendar.set("ganttScale", "quarter");
    calendar.set("groupAxes", mode === "month" ? ["team"] : []);
    calendar.set("laneOrder", ["Blue", "Empty", "Red"]);
    calendar.set("showEmptyLanes", true);
    const wrongCalendar = calendar.clone();
    wrongCalendar.set("query", query("Decoy"));
    target.project.calendars.set(`${mode}-decoy`, wrongCalendar); // Same name, different ID and rows.
    return { ...target, projectId, calendarId, name, first, other, secondChild, decoy };
}
