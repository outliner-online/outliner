import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import {
    editClippedTextAndRead,
    groupedDaysDom,
    mountGroupedDays,
} from "../../tests/fixtures/calendarGroupedDaysProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe.each(["days", "week"] as const)("production grouped %s", viewType => {
    it("matches ordered/empty/multiple lanes, recurrence, clipping and committed order/visibility edits", async () => {
        const { view, results, map } = mountGroupedDays(viewType);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const latest = () => {
            const result = results.at(-1)!;
            if (!result.ready) throw Error(result.reason);
            return result.projection;
        };
        const labels = () =>
            Array.from(view.container.querySelectorAll(".lane-header")).map(node => node.textContent!.trim());
        const initial = latest();
        expect(initial).toEqual(groupedDaysDom(view.container));
        expect(labels()).toEqual(["Red", "Empty", "Blue", "Outside only", "(none)"]);
        expect(initial.labels).toHaveLength((viewType === "days" ? 3 : 7) + 5 * 25);
        const empty = view.getByTestId("calendar-lane-Empty");
        expect(empty.querySelectorAll(".timed-entry,.all-day-entry,.milestone-entry")).toHaveLength(0);
        expect(empty.querySelectorAll(".day-column")).toHaveLength(viewType === "days" ? 3 : 7);
        expect(initial.content.filter(value => value.title === "Early")).toEqual([
            { kind: "timed", title: "Early", day: 0, start: 15 / 1440, end: 75 / 1440, column: 0, columns: 1, lane: 0 },
            { kind: "timed", title: "Early", day: 0, start: 15 / 1440, end: 75 / 1440, column: 0, columns: 2, lane: 2 },
        ]);
        expect(initial.content.find(value => value.title === "Clipped")).toMatchObject({ lane: 0, day: 2, end: 1 });
        expect(initial.content.filter(value => value.title === "Recurring")).toHaveLength(3);
        expect(initial.content.find(value => value.title === "Carry")).toMatchObject({ lane: 0, day: 0, span: 2 });
        expect(initial.content.find(value => value.title === "◆ Due")).toMatchObject({ lane: 2, day: 1 });
        expect(initial.content.filter(value => value.title === "Week only")).toHaveLength(viewType === "week" ? 1 : 0);
        expect(initial.content.some(value => value.title === "Outside")).toBe(false);
        expect(Object.isFrozen(initial.content[0])).toBe(true);

        map.set("laneOrder", ["Blue", "Empty", "Red", "Outside only"]);
        await waitFor(() => expect(labels()[0]).toBe("Blue"));
        expect(latest()).toEqual(groupedDaysDom(view.container));
        map.set("showEmptyLanes", false);
        await waitFor(() => expect(view.queryByTestId("calendar-lane-Empty")).toBeNull());
        expect(labels()).toEqual(["Blue", "Red", "Outside only", "(none)"]);
        expect(latest()).toEqual(groupedDaysDom(view.container));
        expect(initial.content[0]).toEqual({ kind: "lane", lane: 0, label: "Red" });
    }, 45000);

    it("commits a real lane drop and compares fresh clipped SQL independently of publication timing", async () => {
        const fixture = mountGroupedDays(viewType);
        const { view, results, early, outside } = fixture;
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        await fireEvent.dragStart(
            view.getByTestId("calendar-lane-Red").querySelector<HTMLElement>(
                `[data-testid="calendar-entry-lane-handle-outline_items:${early.key}"]`,
            )!,
        );
        await fireEvent.drop(view.getByTestId("calendar-lane-Empty"));
        await waitFor(() => expect(early.tags).toEqual(["Empty"]));
        await waitFor(() => {
            const result = results.at(-1);
            expect(
                result?.ready
                    && result.projection.content.filter(value => value.title === "Early").map(value => value.lane),
            )
                .toEqual([1]);
        });
        expect(view.getByTestId("calendar-lane-Empty").querySelector('[aria-label="Early"]')).toBeTruthy();
        expect(view.getByTestId("calendar-lane-Red").querySelector('[aria-label="Early"]')).toBeNull();
        expect(view.getByTestId("calendar-lane-Blue").querySelector('[aria-label="Early"]')).toBeNull();
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const before = results.at(-1)!;
        expect(before.ready && before.projection).toEqual(groupedDaysDom(view.container));
        const checkpoint = results.length;
        const fresh = await editClippedTextAndRead(fixture, "Changed clipped payload");
        expect(fresh.result.rows.find(row => row.source_id === outside.key)?.title).toBe("Changed clipped payload");
        expect(fresh.comparable.ready && fresh.comparable.model.projection).toEqual(before.ready && before.projection);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        expect(results.at(-1)).toEqual(before);
        expect(view.getByTestId("calendar-lane-Outside only")).toBeTruthy();
        const after = results.at(-1)!;
        expect(after.ready && after.projection).toEqual(groupedDaysDom(view.container));
        console.info("clipped-evidence",
            JSON.stringify({
                viewType,
                rawSQLTitle: fresh.result.rows.find(row => row.source_id === outside.key)?.title,
                freshComparableReady: fresh.comparable.ready,
                nativePublications: results.length - checkpoint,
            }));
    }, 45000);

    it("revokes failed/missing group evidence while retaining fallback display and recovers", async () => {
        const { view, results, map, query } = mountGroupedDays(viewType);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const before = groupedDaysDom(view.container);
        map.set("query", "SELECT broken syntax");
        await waitFor(() => expect(view.getByTestId("calendar-query-error").textContent).toBeTruthy());
        expect(results.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(groupedDaysDom(view.container)).toEqual(before);
        map.set("query", query);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        map.set("groupAxes", ["missing_group"]);
        await waitFor(() =>
            expect(results.at(-1)).toEqual({
                ready: false,
                reason: "Calendar grouping evidence is unavailable or ambiguous.",
            })
        );
        expect(view.getByTestId("calendar-lane-none").querySelector('[aria-label="Early"]')).toBeTruthy();
        expect(view.queryByTestId("calendar-query-error")).toBeNull();
        map.set("groupAxes", ["team"]);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const recovered = results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(groupedDaysDom(view.container));
    }, 45000);
});
