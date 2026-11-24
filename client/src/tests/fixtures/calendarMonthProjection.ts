import type { CalendarObservationContextV1, CalendarProjectionResult } from "$shared/notifications/calendarProjection";
import { render } from "@testing-library/svelte";
import * as Y from "yjs";
import CalendarView from "../../components/calendar/CalendarView.svelte";
import { Items, Project } from "../../schema/app-schema";
import { computeViewRange } from "../../services/calendar/calendarGridRange";
import { createCalendar } from "../../services/calendar/calendarService";
import { createRecurrenceOverride } from "../../services/calendar/recurrenceEditing";

export function mountMonth(writable = false) {
    const doc = new Y.Doc();
    const project = Project.fromDoc(doc);
    const page = new Items(doc, project.tree, "root").addNode("fixture");
    const children = new Items(doc, project.tree, page.key);
    const entry = (text: string, start: string, duration: string, tags = ["Red"], allDay = false) => {
        const item = children.addNode("fixture");
        item.text = text;
        item.start = start;
        item.duration = duration;
        item.allDay = allDay;
        item.tags = tags;
        return item;
    };
    const selected = entry("Night", "2026-04-01T03:30:00Z", "PT30M");
    const hidden = entry("Hidden blue", "2026-04-01T12:00:00Z", "PT1H", ["Blue"]);
    entry("Carry", "2026-03-28", "P5D", ["Red"], true);
    entry("Tail", "2026-04-30", "P5D", ["Red"], true);
    entry("Multiple", "2026-04-02T12:00:00Z", "PT30M", ["Red", "Blue"]);
    entry("Outside", "2026-05-05T12:00:00Z", "PT30M");
    const due = children.addNode("fixture");
    due.text = "Due";
    due.due = "2026-04-03T12:00:00Z";
    due.tags = ["Red"];
    const recurring = entry("Recurring", "2026-03-31T12:00:00Z", "PT30M");
    recurring.rrule = "FREQ=DAILY;COUNT=5";
    recurring.recurrenceDtstart = "2026-03-31T08:00:00";
    recurring.recurrenceTimezone = "America/New_York";
    createRecurrenceOverride(project.tree, recurring, {
        occurrenceId: "2026-04-02T08:00:00",
        startUtcMs: Date.parse("2026-04-02T12:00:00Z"),
    }, { text: "Override" });
    const query = "SELECT id, text AS title, all_day, "
        + (writable ? "start_at" : "CASE WHEN all_day THEN start_on::text ELSE start_at::text END")
        + " AS start_value, duration, due, rrule, recurrence_parent_id, recurrence_occurrence_id, "
        + "tags AS team, 'outline_items' AS source_kind, id AS source_id FROM outline_items ORDER BY id";
    const calendarId = createCalendar(project, {
        name: "Month projection",
        query,
        viewType: "week",
        timezone: "UTC",
        weekStart: 0,
        groupAxes: ["team"],
        laneOrder: ["Red", "Empty", "Blue"],
        showEmptyLanes: true,
        roleTitle: "title",
        roleStart: "start_value",
        roleDuration: "duration",
        roleDue: "due",
        roleAllDay: "all_day",
    });
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
        view,
        results,
        query,
        context,
        selected,
        hidden,
        map: project.calendars.get(calendarId)!,
    };
}

/** Read painted cells, text, order and CSS independently of all Calendar derivation helpers. */
export function monthDom(root: HTMLElement) {
    const filter = root.querySelector<HTMLSelectElement>('[data-testid="calendar-month-lane-filter"]');
    const headers = Array.from(root.querySelectorAll(".weekday-label")).map(node => node.textContent!.trim());
    const content: Record<string, string | number | boolean | null>[] = filter
        ? [{ kind: "lane-filter", label: filter.selectedOptions[0].textContent! }]
        : [];
    Array.from(root.querySelectorAll(".month-cell")).forEach((node, cell) => {
        content.push({ kind: "cell", cell, label: node.querySelector(".cell-date")!.textContent! });
        for (const [selector, kind] of [[".milestone-chip", "due"], [".entry-chip", "entry"]]) {
            Array.from(node.querySelectorAll<HTMLElement>(selector)).forEach((chip, order) => {
                const value: Record<string, string | number> = {
                    kind,
                    cell,
                    order,
                    title: chip.querySelector(".chip-title")!.textContent!,
                };
                if (kind === "entry") {
                    const rgb = chip.style.background.match(/\d+/g)!.map(Number);
                    value.background = "#" + rgb.map(n => n.toString(16).padStart(2, "0")).join("");
                }
                content.push(value);
            });
        }
    });
    return {
        version: 1,
        title: root.querySelector('[data-testid="calendar-name"]')!.textContent,
        rangeLabel: root.querySelector('[data-testid="calendar-range-label"]')!.textContent,
        modeLabel:
            root.querySelector<HTMLSelectElement>('[data-testid="calendar-view-type"]')!.selectedOptions[0].textContent,
        labels: [...(filter ? Array.from(filter.options).map(option => option.textContent!) : []), ...headers],
        content,
    };
}
