import type { CalendarObservationContextV1, CalendarProjectionResult } from "$shared/notifications/calendarProjection";
import { render } from "@testing-library/svelte";
import * as Y from "yjs";
import CalendarView from "../../components/calendar/CalendarView.svelte";
import { Items, Project } from "../../schema/app-schema";
import { computeViewRange } from "../../services/calendar/calendarGridRange";
import { createCalendar } from "../../services/calendar/calendarService";

export function mountDays(viewType: "day" | "days" | "week", withContext = true, grouped = false) {
    const doc = new Y.Doc();
    const project = Project.fromDoc(doc);
    const page = new Items(doc, project.tree, "root").addNode("fixture");
    const children = new Items(doc, project.tree, page.key);
    const timed = (text: string, start: string, duration: string) => {
        const item = children.addNode("fixture");
        item.text = text;
        item.start = start;
        item.duration = duration;
        item.allDay = false;
        return item;
    };
    const early = timed("Early", "2026-03-15T15:15:00Z", "PT1H");
    const overlap = timed("Overlap", "2026-03-15T15:30:00Z", "PT1H");
    const clipped = timed("Clipped", viewType === "day" ? "2026-03-16T14:30:00Z" : "2026-03-18T14:30:00Z", "PT2H");
    timed("Week only", "2026-03-22T01:00:00Z", "PT1H");
    const outside = timed("Outside", "2026-03-23T00:00:00Z", "PT1H");
    const allDay = timed("Carry", "2026-03-15", "P3D");
    allDay.allDay = true;
    const due = children.addNode("fixture");
    due.text = "Due";
    due.due = viewType === "day" ? "2026-03-16T04:00:00Z" : "2026-03-17T04:00:00Z";
    const recurring = timed("Recurring", "2026-03-15T23:00:00Z", "PT30M");
    recurring.rrule = "FREQ=DAILY;COUNT=3";
    recurring.recurrenceDtstart = "2026-03-16T08:00:00";
    recurring.recurrenceTimezone = "Asia/Tokyo";
    if (grouped) {
        early.tags = ["Red", "Blue"];
        overlap.tags = ["Blue"];
        clipped.tags = allDay.tags = recurring.tags = ["Red"];
        due.tags = ["Blue"];
        outside.tags = ["Outside only"];
    }
    const query = "SELECT id, text AS title, text || ' revised' AS alternate_title, all_day, "
        + "CASE WHEN all_day THEN start_on::text ELSE start_at::text END AS start_value, "
        + "duration, due, rrule, " + (grouped ? "tags" : "'Team A'")
        + " AS team, " + (grouped ? "'outline_items'" : "'item'")
        + " AS source_kind, id AS source_id FROM outline_items ORDER BY id";
    const calendarId = createCalendar(project, {
        name: "Days projection",
        query,
        viewType,
        timezone: "UTC",
        weekStart: 0,
        groupAxes: grouped ? ["team"] : [],
        laneOrder: grouped ? ["Red", "Empty", "Blue"] : [],
        showEmptyLanes: grouped,
        roleTitle: "title",
        roleStart: "start_value",
        roleDuration: "duration",
        roleAllDay: "all_day",
        roleDue: "due",
    });
    const anchorUtcMs = Date.parse("2026-03-16T00:00:00Z");
    const range = computeViewRange(anchorUtcMs, viewType, 1, "Asia/Tokyo");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "Asia/Tokyo",
        weekStart: 1,
        viewType,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
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
        doc,
        project,
        calendarId,
        view,
        results,
        query,
        context,
        early,
        outside,
        map: project.calendars.get(calendarId)!,
    };
}

/** Independent DOM/CSS reader: no layout, entry derivation or projection helper. */
export function timeGridDom(grid: HTMLElement) {
    const days = Array.from(grid.querySelectorAll<HTMLElement>(".day-column"));
    const title = (node: Element) => node.querySelector(".entry-title")!.textContent!.trim();
    const percentages = (value: string) => (value.match(/-?[\d.]+(?=%)/g) ?? []).map(Number);
    const content: Record<string, string | number | boolean | null>[] = [];
    for (const node of grid.querySelectorAll<HTMLElement>(".timed-entry")) {
        // Width includes the renderer's fixed 2px gap; only its percentage
        // determines the overlap column count. CSSOM may simplify calc().
        const columns = Math.round(100 / days.length / percentages(node.style.width)[0]);
        const position = percentages(node.style.left).reduce((sum, value) => sum + value, 0) * days.length / 100;
        const day = Math.floor(position + 1e-5);
        const start = parseFloat(node.style.top) / 1152;
        content.push({
            kind: "timed",
            title: title(node),
            day,
            start,
            end: (parseFloat(node.style.top) + parseFloat(node.style.height)) / 1152,
            column: Math.max(0, Math.round((position - day) * columns)),
            columns,
        });
    }
    for (const node of grid.querySelectorAll<HTMLElement>(".all-day-entry")) {
        const [column, span] = node.style.gridColumn.match(/\d+/g)!.map(Number);
        content.push({ kind: "all-day", title: title(node), day: column - 1, span });
    }
    for (const node of grid.querySelectorAll<HTMLElement>(".milestone-entry")) {
        content.push({ kind: "due", title: title(node), day: parseInt(node.style.gridColumn) - 1 });
    }
    days.forEach((node, day) => {
        const band = node.querySelector<HTMLElement>(".working-hours-band")!;
        const start = parseFloat(band.style.top) * 60 / 48;
        content.push({ kind: "working-hours", day, start, end: start + parseFloat(band.style.height) * 60 / 48 });
    });
    return {
        labels: [
            ...Array.from(grid.querySelectorAll(".day-header-cell")).map(node => node.textContent!.trim()),
            ...Array.from(grid.querySelectorAll(".hour-label")).map(node => node.textContent!.trim()),
        ],
        content,
    };
}

export function daysDom(root: HTMLElement) {
    return {
        version: 1,
        title: root.querySelector('[data-testid="calendar-name"]')!.textContent,
        rangeLabel: root.querySelector('[data-testid="calendar-range-label"]')!.textContent,
        modeLabel:
            root.querySelector<HTMLSelectElement>('[data-testid="calendar-view-type"]')!.selectedOptions[0].textContent,
        ...timeGridDom(root.querySelector<HTMLElement>('[data-testid="calendar-time-grid"]')!),
    };
}
