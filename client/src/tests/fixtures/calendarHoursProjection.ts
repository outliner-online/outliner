import type { CalendarObservationContextV1, CalendarProjectionResult } from "$shared/notifications/calendarProjection";
import { render } from "@testing-library/svelte";
import * as Y from "yjs";
import CalendarView from "../../components/calendar/CalendarView.svelte";
import { Items, Project } from "../../schema/app-schema";
import { computeViewRange } from "../../services/calendar/calendarGridRange";
import { createCalendar } from "../../services/calendar/calendarService";
import { createRecurrenceOverride } from "../../services/calendar/recurrenceEditing";

export function mountHours(options: { postReadyRecurrence?: boolean; } = {}) {
    const doc = new Y.Doc({ guid: "hours-projection-fixture" });
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
    const folded = timed("Folded", "2026-03-08T13:45:00Z", "PT95M");
    timed("Overlap", "2026-03-08T14:00:00Z", "PT15M");
    timed("Clipped", "2026-03-09T03:30:00Z", "PT2H");
    timed("Hidden next day", "2026-03-09T13:00:00Z", "PT1H");
    const allDay = timed("All day", "2026-03-08", "P1D");
    allDay.allDay = true;
    const due = children.addNode("fixture");
    due.text = "Due";
    due.due = "2026-03-08T16:00:00Z";
    const recurring = timed(options.postReadyRecurrence ? "Series" : "Replaced occurrence",
        options.postReadyRecurrence ? "2026-03-08T12:00:00Z" : "2026-03-07T13:00:00Z", "PT30M");
    recurring.rrule = options.postReadyRecurrence ? "FREQ=HOURLY;COUNT=3" : "FREQ=DAILY;COUNT=3";
    recurring.recurrenceDtstart = options.postReadyRecurrence ? "2026-03-08T08:00:00" : "2026-03-07T08:00:00";
    recurring.recurrenceTimezone = "America/New_York";
    if (!options.postReadyRecurrence) {
        createRecurrenceOverride(project.tree, recurring, {
            occurrenceId: "2026-03-08T08:00:00",
            startUtcMs: Date.parse("2026-03-08T12:00:00Z"),
        }, { text: "Actual override" });
    }
    const query = "SELECT id AS id, text AS title, text || ' revised' AS alternate_title, all_day AS all_day, "
        + "CASE WHEN all_day THEN start_on::text ELSE start_at::text END AS start_value, "
        + "duration AS duration, due AS due, rrule AS rrule, "
        + "recurrence_parent_id AS recurrence_parent_id, recurrence_occurrence_id AS recurrence_occurrence_id, "
        + "'item' AS source_kind, id AS source_id FROM outline_items";
    const calendarId = createCalendar(project, {
        name: "Hours projection",
        query,
        viewType: "hours",
        timezone: "America/New_York",
        roleTitle: "title",
        roleStart: "start_value",
        roleDuration: "duration",
        roleAllDay: "all_day",
        roleDue: "due",
        groupAxes: ["unused"],
    });
    const anchorUtcMs = Date.UTC(2026, 2, 8, 16);
    const range = computeViewRange(anchorUtcMs, "hours", 1, "America/New_York");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "hours",
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
        observationContext: context,
        onVisibleProjection: (result: CalendarProjectionResult) => results.push(result),
    });
    return {
        doc,
        project,
        calendarId,
        context,
        folded,
        recurring,
        query,
        results,
        view,
        map: project.calendars.get(calendarId)!,
    };
}

/** Read actual painted DOM semantics, never the layout/producer used to build them. */
export function hoursDom(root: HTMLElement) {
    const grid = root.querySelector<HTMLElement>('[data-testid="calendar-hour-minute-grid"]')!;
    const rows = Array.from(grid.querySelectorAll<HTMLElement>(".hour-row"));
    const text = (selector: string) => grid.querySelector(selector)?.textContent?.trim() ?? "";
    // CSSOM rounds percentage strings (e.g. 33.3333%); normalize its
    // sub-millisecond-to-millisecond serialization noise back to minutes.
    const minutes = (value: string) => Math.round(parseFloat(value) * 60 / 100 * 1e4) / 1e4;
    const content: Record<string, string | number | boolean | null>[] = [
        ...Array.from(grid.querySelectorAll('[data-testid^="calendar-entry-allday-"]'))
            .map(node => ({ kind: "all-day", title: node.getAttribute("aria-label")! })),
        ...Array.from(grid.querySelectorAll('[data-testid^="calendar-entry-milestone-"]'))
            .map(node => ({ kind: "due", title: node.getAttribute("aria-label")! })),
    ];
    rows.forEach((row, index) => {
        const working = row.querySelector<HTMLElement>(".working-hours-band");
        const lanes = Number(row.dataset.laneCount);
        content.push({
            kind: "hour-row",
            row: index,
            label: row.querySelector(".hour-gutter")!.textContent!.trim(),
            lanes,
            workingStart: working ? minutes(working.style.left) : null,
            workingEnd: working ? minutes(working.style.left) + minutes(working.style.width) : null,
        });
        for (const fragment of row.querySelectorAll<HTMLElement>(".fragment")) {
            const start = minutes(fragment.style.left);
            content.push({
                kind: "fragment",
                row: index,
                start,
                end: start + minutes(fragment.style.width),
                // The renderer's 22px sub-lane is normalized back to a logical lane.
                lane: parseFloat(fragment.style.top) / 22,
                lanes,
                title: fragment.querySelector(".entry-title:not(.visually-hidden)")?.textContent ?? "",
                label: fragment.getAttribute("aria-label")!,
                first: !fragment.classList.contains("continues-left"),
                last: !fragment.classList.contains("continues-right"),
            });
        }
    });
    return {
        version: 1,
        title: root.querySelector('[data-testid="calendar-name"]')!.textContent,
        rangeLabel: root.querySelector('[data-testid="calendar-range-label"]')!.textContent,
        modeLabel:
            root.querySelector<HTMLSelectElement>('[data-testid="calendar-view-type"]')!.selectedOptions[0].textContent,
        labels: [text('[data-testid="calendar-hour-map-day-label"]'),
            ...Array.from(grid.querySelectorAll(".minute-tick")).map(node => node.textContent!.trim()),
            ...rows.map(row => row.querySelector(".hour-gutter")!.textContent!.trim())],
        content,
    };
}
