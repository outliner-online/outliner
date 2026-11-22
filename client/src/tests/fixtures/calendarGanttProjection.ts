import type { CalendarObservationContextV1, CalendarProjectionResult } from "$shared/notifications/calendarProjection";
import { render } from "@testing-library/svelte";
import * as Y from "yjs";
import CalendarView from "../../components/calendar/CalendarView.svelte";
import { Items, Project } from "../../schema/app-schema";
import { computeGanttRange, type GanttScale } from "../../services/calendar/calendarGridRange";
import { createCalendar } from "../../services/calendar/calendarService";

export function mountGantt(collapsed = false, scale: GanttScale = "day", withContext = true) {
    const doc = new Y.Doc();
    const project = Project.fromDoc(doc);
    const page = new Items(doc, project.tree, "root").addNode("fixture");
    const start = Date.parse("2026-04-01T04:00:00Z");
    const day = 86_400_000;
    const entry = (parent: string, text: string, offset?: number, duration?: string) => {
        const item = new Items(doc, project.tree, parent).addNode("fixture");
        item.text = text;
        item.allDay = false;
        if (offset !== undefined) item.start = new Date(start + offset * day).toISOString();
        if (duration !== undefined) item.duration = duration;
        return item;
    };
    const parent = entry(page.key, "Parent", 20, "P1D");
    parent.due = new Date(start + 11 * day).toISOString();
    entry(parent.key, "Early", -2, "P5D");
    entry(parent.key, "Point", 4);
    const nested = entry(parent.key, "Nested", 23, "P1D");
    const grandchild = entry(nested.key, "Grandchild", 6, "P2D");
    const due = entry(parent.key, "Due");
    due.due = new Date(start + 10 * day).toISOString();
    entry(page.key, "Tiny", 12, "PT1M");
    const recurring = entry(page.key, "Recurring", 15, "PT1H");
    recurring.rrule = "FREQ=DAILY;COUNT=2";
    recurring.recurrenceDtstart = "2026-04-16T00:00:00";
    recurring.recurrenceTimezone = "America/New_York";
    const outside = entry(page.key, "Outside", 45, "P1D");
    const query = "SELECT id, parent_id, text AS title, all_day, "
        + "CASE WHEN all_day THEN start_on::text ELSE start_at::text END AS start_value, "
        + "duration, due, rrule, tags AS team, 'outline_items' AS source_kind, id AS source_id "
        + "FROM outline_items ORDER BY id";
    const calendarId = createCalendar(project, {
        name: "Gantt projection",
        query,
        viewType: "gantt",
        timezone: "UTC",
        ganttScale: "quarter",
        groupAxes: [],
        roleTitle: "title",
        roleStart: "start_value",
        roleDuration: "duration",
        roleDue: "due",
        roleAllDay: "all_day",
    });
    const range = computeGanttRange(start, scale, "America/New_York");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "gantt",
        ganttScale: scale,
        anchorUtcMs: start,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: collapsed ? [`outline_items:${parent.key}`] : [],
    };
    const results: CalendarProjectionResult[] = [];
    const view = render(CalendarView, {
        project,
        projectId: doc.guid,
        calendarId,
        observationContext: withContext ? context : undefined,
        onVisibleProjection: (result: CalendarProjectionResult) => results.push(result),
    });
    return {
        view,
        results,
        map: project.calendars.get(calendarId)!,
        parent,
        nested,
        grandchild,
        outside,
        doc,
        context,
        query,
    };
}
