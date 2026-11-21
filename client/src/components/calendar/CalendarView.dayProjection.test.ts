import type { CalendarObservationContextV1, CalendarProjectionResult } from "$shared/notifications/calendarProjection";
import { configure, render, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Items, Project } from "../../schema/app-schema";
import { computeViewRange } from "../../services/calendar/calendarGridRange";
import { createCalendar, destroyCalendarUndoManager } from "../../services/calendar/calendarService";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import CalendarView from "./CalendarView.svelte";

configure({ asyncUtilTimeout: 15000 });

afterEach(async () => {
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});

afterAll(async () => {
    await resetPgliteForTests();
});

describe("CalendarView Day projection boundary", { timeout: 30000 }, () => {
    it("matches the mounted Day DOM and rejects stale accepted-result evidence", async () => {
        const projectId = "proj-calendar-day-projection";
        const projectDoc = new Y.Doc({ guid: projectId });
        const project = Project.fromDoc(projectDoc);
        const page = new Items(projectDoc, project.tree, "root").addNode("tester");
        const item = new Items(projectDoc, project.tree, page.key).addNode("tester");
        item.text = "Projection standup";
        const anchorUtcMs = Date.now();
        item.start = new Date(anchorUtcMs).toISOString();
        item.allDay = false;
        item.duration = "PT30M";

        const calendarId = createCalendar(project, {
            name: "Day projection",
            query: "SELECT id, text AS title, all_day, start_at, duration, "
                + "'item' AS source_kind, id AS source_id FROM outline_items",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "title",
            roleStart: "start_at",
            roleAllDay: "all_day",
            roleDuration: "duration",
        });
        const range = computeViewRange(anchorUtcMs, "day", 1, "UTC");
        const observationContext: CalendarObservationContextV1 = {
            version: 1,
            locale: "en-US",
            timeZone: "UTC",
            weekStart: 1,
            viewType: "day",
            anchorUtcMs,
            rangeStartUtcMs: range.start,
            rangeEndUtcMs: range.end,
            monthLaneFilter: null,
            collapsedEntryKeys: [],
        };
        const projections: CalendarProjectionResult[] = [];
        const component = render(CalendarView, {
            props: {
                project,
                projectId,
                calendarId,
                observationContext,
                onVisibleProjection: result => projections.push(result),
            },
        });

        await waitFor(() => expect(component.getByTestId(`calendar-entry-item:${item.key}`)).toBeTruthy());
        await waitFor(() => expect(projections.some(result => result.ready)).toBe(true));
        const ready = projections.find(result => result.ready);
        expect(ready?.ready && ready.projection.content.map(value => value.title)).toContain("Projection standup");
        expect(component.getByTestId(`calendar-entry-item:${item.key}`).textContent).toContain("Projection standup");

        const calendarMap = projectDoc.getMap("calendars").get(calendarId) as Y.Map<unknown>;
        calendarMap.set("query", "SELECT broken syntax");
        await waitFor(() => expect(component.getByTestId("calendar-stale-result")).toBeTruthy());
        await waitFor(() => expect(projections.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        }));
        expect(component.getByTestId(`calendar-entry-item:${item.key}`)).toBeTruthy();

        destroyCalendarUndoManager(projectDoc);
    });
});
