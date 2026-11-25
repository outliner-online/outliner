import * as Y from "yjs";
import { Items, Project } from "../../../shared/src/app-schema";
import {
    type CalendarObservationContextV1,
    encodeCalendarObservationContext,
} from "../../../shared/src/notifications/calendarProjection";
import { computeViewRange } from "../../../shared/src/services/calendarGridRange";

export function savedContext(): CalendarObservationContextV1 {
    const anchorUtcMs = Date.UTC(2026, 2, 8, 12);
    const range = computeViewRange(anchorUtcMs, "week", 1, "America/New_York");
    return {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "week",
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
}

export function savedPath(projectId: string, calendarId: string, context = savedContext()) {
    return `/${encodeURIComponent(projectId)}/-/calendars/${encodeURIComponent(calendarId)}?context=${
        encodeURIComponent(encodeCalendarObservationContext(context))
    }`;
}

export function calendarProject(projectId: string, title: string, calendarId: string, name: string) {
    const doc = new Y.Doc({ guid: projectId });
    const project = Project.fromDoc(doc);
    project.title = title;
    const page = new Items(doc, project.tree, "root").addNode("fixture");
    page.text = `${name} page`;
    const item = new Items(doc, project.tree, page.key).addNode("fixture");
    item.text = `${name} entry`;
    item.start = "2026-03-08T13:00:00.000Z";
    item.duration = "PT30M";
    item.allDay = false;
    project.calendars.set(calendarId, new Y.Map<unknown>(Object.entries({
        name,
        viewType: "month",
        timezone: "Asia/Tokyo",
        weekStart: 0,
        query: "SELECT id AS id, text AS title, all_day AS all_day, start_at AS start_at, "
            + "duration AS duration, 'item' AS source_kind, id AS source_id FROM outline_items",
        sqlAliasPolicyVersion: 1,
        roleTitle: "title",
        roleStart: "start_at",
        roleAllDay: "all_day",
        roleDuration: "duration",
    })) as never);
    return { doc, project, itemId: item.key };
}
