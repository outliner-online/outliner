import type { CalendarObservationContextV1, CalendarProjectionResult } from "$shared/notifications/calendarProjection";
import { configure, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Items, Project } from "../../schema/app-schema";
import { computeViewRange } from "../../services/calendar/calendarGridRange";
import * as runner from "../../services/calendar/calendarQueryRunner";
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
        const overlappingItem = new Items(projectDoc, project.tree, page.key).addNode("tester");
        overlappingItem.text = "Overlapping standup";
        overlappingItem.start = new Date(anchorUtcMs).toISOString();
        overlappingItem.allDay = false;
        overlappingItem.duration = "PT30M";
        const dueItem = new Items(projectDoc, project.tree, page.key).addNode("tester");
        dueItem.text = "Projection deadline";
        dueItem.due = new Date(anchorUtcMs).toISOString();

        const calendarId = createCalendar(project, {
            name: "Day projection",
            query: "SELECT id, text AS title, all_day, start_at, duration, due, "
                + "'item' AS source_kind, id AS source_id FROM outline_items",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "title",
            roleStart: "start_at",
            roleAllDay: "all_day",
            roleDuration: "duration",
            roleDue: "due",
            workingHoursStartMinutes: 480,
            workingHoursEndMinutes: 1020,
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
        if (!ready?.ready) throw new Error("Expected a ready Day projection");
        expect(ready.projection.modeLabel).toBe("Day");
        const displayedLabels = [...component.container.querySelectorAll(".day-header-cell, .hour-label")]
            .map(node => node.textContent);
        expect(ready.projection.labels).toEqual(displayedLabels);
        expect(ready.projection.labels).toHaveLength(25);
        const timed = ready.projection.content.filter(value => value.kind === "timed");
        expect(timed.filter(value => value.title?.includes("standup"))).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: "Projection standup", column: expect.any(Number), columns: 2 }),
            expect.objectContaining({ title: "Overlapping standup", column: expect.any(Number), columns: 2 }),
        ]));
        const milestone = component.getByTestId(`calendar-entry-milestone-item:${dueItem.key}`);
        expect(milestone.textContent).toContain("◆ Projection deadline");
        expect(ready.projection.content).toContainEqual(expect.objectContaining({
            kind: "due",
            title: "◆ Projection deadline",
        }));
        expect(ready.projection.content).toContainEqual({ kind: "working-hours", day: 0, start: 480, end: 1020 });

        const calendarMap = projectDoc.getMap("calendars").get(calendarId) as Y.Map<unknown>;
        calendarMap.set("workingHoursStartMinutes", 600);
        calendarMap.set("workingHoursEndMinutes", 900);
        await waitFor(() => expect(projections.at(-1)).toEqual(expect.objectContaining({
            ready: true,
            projection: expect.objectContaining({
                content: expect.arrayContaining([
                    { kind: "working-hours", day: 0, start: 600, end: 900 },
                ]),
            }),
        })));
        await waitFor(() => {
            const band = component.container.querySelector(".working-hours-band") as HTMLElement | null;
            expect(band?.getAttribute("style")).toContain("top: 480px");
            expect(band?.getAttribute("style")).toContain("height: 240px");
        });

        calendarMap.set("query", "SELECT broken syntax");
        await waitFor(() => expect(component.getByTestId("calendar-stale-result")).toBeTruthy());
        await waitFor(() => expect(projections.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        }));
        expect(component.getByTestId(`calendar-entry-item:${item.key}`)).toBeTruthy();

        destroyCalendarUndoManager(projectDoc);
    });

    it("re-derives the DOM and projection after a committed title-role-only edit", async () => {
        const projectId = "proj-calendar-day-role-projection";
        const projectDoc = new Y.Doc({ guid: projectId });
        const project = Project.fromDoc(projectDoc);
        const page = new Items(projectDoc, project.tree, "root").addNode("tester");
        const item = new Items(projectDoc, project.tree, page.key).addNode("tester");
        item.text = "Primary title";
        const anchorUtcMs = Date.now();
        item.start = new Date(anchorUtcMs).toISOString();
        item.allDay = false;
        item.duration = "PT30M";
        const calendarId = createCalendar(project, {
            name: "Role projection",
            query:
                "SELECT id, text AS primary_title, 'Alternate title' AS alternate_title, all_day, start_at, duration, "
                + "'item' AS source_kind, id AS source_id FROM outline_items",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "primary_title",
            roleStart: "start_at",
            roleAllDay: "all_day",
            roleDuration: "duration",
        });
        const range = computeViewRange(anchorUtcMs, "day", 1, "UTC");
        const projections: CalendarProjectionResult[] = [];
        const component = render(CalendarView, {
            props: {
                project,
                projectId,
                calendarId,
                observationContext: {
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
                },
                onVisibleProjection: result => projections.push(result),
            },
        });
        const entry = () => component.getByTestId(`calendar-entry-item:${item.key}`);
        await waitFor(() => expect(entry().textContent).toContain("Primary title"));

        const calendarMap = projectDoc.getMap("calendars").get(calendarId) as Y.Map<unknown>;
        calendarMap.set("roleTitle", "alternate_title");
        await waitFor(() => expect(entry().textContent).toContain("Alternate title"));
        await waitFor(() => {
            const latest = projections.at(-1);
            expect(latest?.ready && latest.projection.content.map(value => value.title)).toContain("Alternate title");
        });
    });

    it("uses a title-role edit committed while the initial query is in flight", async () => {
        const projectId = "proj-calendar-day-pending-role";
        const projectDoc = new Y.Doc({ guid: projectId });
        const project = Project.fromDoc(projectDoc);
        const calendarId = createCalendar(project, {
            name: "Pending role",
            query: "SELECT 1",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "primary_title",
            roleStart: "start_at",
        });
        let resolveQuery: ((value: runner.CalendarQueryOutcome) => void) | undefined;
        const spy = vi.spyOn(runner, "runCalendarQuery").mockImplementation(() =>
            new Promise(resolve => {
                resolveQuery = resolve;
            })
        );
        const projections: CalendarProjectionResult[] = [];
        const component = render(CalendarView, {
            props: { project, projectId, calendarId, onVisibleProjection: result => projections.push(result) },
        });
        await waitFor(() => expect(resolveQuery).toBeDefined());
        const calendarMap = projectDoc.getMap("calendars").get(calendarId) as Y.Map<unknown>;
        calendarMap.set("roleTitle", "alternate_title");
        resolveQuery!({
            result: {
                columns: ["primary_title", "alternate_title", "start_at", "source_kind", "source_id"],
                rows: [{
                    primary_title: "Captured title",
                    alternate_title: "Latest title",
                    start_at: new Date().toISOString(),
                    source_kind: "item",
                    source_id: "pending-role",
                }],
            },
        });
        await waitFor(() =>
            expect(component.getByTestId("calendar-entry-item:pending-role").textContent).toContain("Latest title")
        );
        await waitFor(() => {
            const latest = projections.at(-1);
            expect(latest?.ready && latest.projection.content.map(value => value.title)).toContain("Latest title");
        });
        spy.mockRestore();
    });

    it("publishes accepted grouped Day bands through the native lane renderer", async () => {
        const projectId = "proj-calendar-grouped-day-projection";
        const projectDoc = new Y.Doc({ guid: projectId });
        const project = Project.fromDoc(projectDoc);
        const page = new Items(projectDoc, project.tree, "root").addNode("tester");
        const item = new Items(projectDoc, project.tree, page.key).addNode("tester");
        item.text = "Grouped entry";
        const anchorUtcMs = Date.now();
        item.start = new Date(anchorUtcMs).toISOString();
        item.allDay = false;
        item.duration = "PT30M";
        const calendarId = createCalendar(project, {
            name: "Grouped Day",
            query: "SELECT id, text AS title, 'Team A' AS team, all_day, start_at, duration, "
                + "'item' AS source_kind, id AS source_id FROM outline_items",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "title",
            roleStart: "start_at",
            roleAllDay: "all_day",
            roleDuration: "duration",
            groupAxes: ["team"],
        });
        const range = computeViewRange(anchorUtcMs, "day", 1, "UTC");
        const projections: CalendarProjectionResult[] = [];
        const component = render(CalendarView, {
            props: {
                project,
                projectId,
                calendarId,
                observationContext: {
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
                },
                onVisibleProjection: result => projections.push(result),
            },
        });
        await waitFor(() => expect(component.getByTestId("calendar-lane-time-grid")).toBeTruthy());
        await waitFor(() => expect(projections.at(-1)?.ready).toBe(true));
        const grouped = projections.at(-1)!;
        expect(grouped.ready && grouped.projection.modeLabel).toBe("Day");
        expect(grouped.ready && grouped.projection.content[0]).toEqual({ kind: "lane", lane: 0, label: "Team A" });
        expect(component.getByTestId("calendar-lane-Team A")).toBeTruthy();
    });

    it("cannot publish a previous Day response after navigation invalidates its generation", async () => {
        const projectId = "proj-calendar-day-navigation-generation";
        const projectDoc = new Y.Doc({ guid: projectId });
        const project = Project.fromDoc(projectDoc);
        const calendarId = createCalendar(project, {
            name: "Navigation generation",
            query: "SELECT 1 AS id, 'Old day' AS title, now() AS start_at",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "title",
            roleStart: "start_at",
        });
        let firstResolve: ((value: runner.CalendarQueryOutcome) => void) | undefined;
        let secondResolve: ((value: runner.CalendarQueryOutcome) => void) | undefined;
        let calls = 0;
        const spy = vi.spyOn(runner, "runCalendarQuery").mockImplementation(async () => {
            calls++;
            return new Promise(resolve => {
                if (calls === 1) firstResolve = resolve;
                else secondResolve = resolve;
            });
        });
        const projections: CalendarProjectionResult[] = [];
        const component = render(CalendarView, {
            props: { project, projectId, calendarId, onVisibleProjection: result => projections.push(result) },
        });
        await waitFor(() => expect(calls).toBe(1));
        await fireEvent.click(component.getByTestId("calendar-nav-next"));
        expect(projections.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        firstResolve!({
            result: {
                columns: ["id", "title", "start_at"],
                rows: [{ id: 1, title: "Old day", start_at: new Date().toISOString() }],
            },
        });
        await waitFor(() => expect(calls).toBe(2));
        expect(projections.some(result => result.ready)).toBe(false);
        secondResolve!({ result: { columns: [], rows: [] } });
        await waitFor(() => expect(projections.some(result => result.ready)).toBe(true));
        spy.mockRestore();
    });

    it("fences an in-flight response when query authority changes before the debounce", async () => {
        const projectId = "proj-calendar-day-query-generation";
        const projectDoc = new Y.Doc({ guid: projectId });
        const project = Project.fromDoc(projectDoc);
        const calendarId = createCalendar(project, {
            name: "Query generation",
            query: "SELECT 1 AS id, 'Old query' AS title, now() AS start_at",
            viewType: "day",
            timezone: "UTC",
            roleTitle: "title",
            roleStart: "start_at",
        });
        const resolvers: Array<(value: runner.CalendarQueryOutcome) => void> = [];
        const spy = vi.spyOn(runner, "runCalendarQuery").mockImplementation(() =>
            new Promise(resolve => resolvers.push(resolve))
        );
        const projections: CalendarProjectionResult[] = [];
        render(CalendarView, {
            props: { project, projectId, calendarId, onVisibleProjection: result => projections.push(result) },
        });
        await waitFor(() => expect(resolvers).toHaveLength(1));
        const calendarMap = projectDoc.getMap("calendars").get(calendarId) as Y.Map<unknown>;
        calendarMap.set("query", "SELECT 2 AS id, 'New query' AS title, now() AS start_at");
        expect(projections.at(-1)?.ready).toBe(false);
        resolvers[0]!({
            result: {
                columns: ["id", "title", "start_at"],
                rows: [{ id: 1, title: "Old query", start_at: new Date().toISOString() }],
            },
        });
        await waitFor(() => expect(resolvers).toHaveLength(2));
        expect(projections.some(result => result.ready)).toBe(false);
        resolvers[1]!({ result: { columns: [], rows: [] } });
        await waitFor(() => expect(projections.some(result => result.ready)).toBe(true));
        calendarMap.set("viewType", "week");
        await waitFor(() => expect(projections.at(-1)?.ready).toBe(false));
        spy.mockRestore();
    });
});
