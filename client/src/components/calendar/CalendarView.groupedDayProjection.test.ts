import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { mountDays } from "../../tests/fixtures/calendarDaysProjection";
import { groupedDaysDom } from "../../tests/fixtures/calendarGroupedDaysProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("production grouped Day accepted bands", () => {
    it("renders literal Day lanes, overlap, recurrence, clipping, empty lanes and committed settings", async () => {
        const f = mountDays("day", true, true);
        const latest = () => {
            const value = f.results.at(-1)!;
            if (!value.ready) throw Error(value.reason);
            return value.projection;
        };
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        const before = latest();
        expect(before).toEqual(groupedDaysDom(f.view.container));
        expect(before.modeLabel).toBe("Day");
        const labels = () =>
            Array.from(f.view.container.querySelectorAll(".lane-header"))
                .map(node => node.textContent!.trim());
        expect(labels()).toEqual(["Red", "Empty", "Blue", "Outside only", "(none)"]);
        expect(before.labels).toHaveLength(126);
        expect(f.view.container.querySelectorAll(".day-column")).toHaveLength(5);
        expect(
            f.view.getByTestId("calendar-lane-Empty").querySelectorAll(".timed-entry,.all-day-entry,.milestone-entry"),
        )
            .toHaveLength(0);
        expect(before.content.filter(value => value.title === "Early")).toEqual([
            { kind: "timed", title: "Early", day: 0, start: 15 / 1440, end: 75 / 1440, column: 0, columns: 1, lane: 0 },
            { kind: "timed", title: "Early", day: 0, start: 15 / 1440, end: 75 / 1440, column: 0, columns: 2, lane: 2 },
        ]);
        expect(before.content.find(value => value.title === "Clipped"))
            .toMatchObject({ day: 0, start: 47 / 48, end: 1, lane: 0 });
        expect(before.content.filter(value => value.title === "Recurring")).toHaveLength(1);
        expect(before.content.find(value => value.title === "Carry")).toMatchObject({ day: 0, span: 1, lane: 0 });
        expect(before.content.find(value => value.title === "◆ Due")).toMatchObject({ day: 0, lane: 2 });
        expect(before.content.some(value => value.title === "Outside" || value.title === "Week only")).toBe(false);
        expect(f.view.getByTestId("calendar-lane-Blue").querySelector('[aria-label="Early"]')).toBeTruthy();
        expect(Object.isFrozen(before.content[0])).toBe(true);
        f.doc.transact(() => {
            f.map.set("groupAxes", ["team", "unselected_deeper_axis"]);
            f.map.set("laneOrder", ["Blue", "Empty", "Red", "Outside only"]);
            f.map.set("workingHoursStartMinutes", 480);
            f.map.set("workingHoursEndMinutes", 1020);
        });
        await waitFor(() => {
            expect(labels()[0]).toBe("Blue");
            expect(latest().content.filter(value => value.kind === "working-hours"))
                .toEqual([0, 1, 2, 3, 4].map(lane => ({ kind: "working-hours", lane, day: 0, start: 480, end: 1020 })));
        });
        expect(latest()).toEqual(groupedDaysDom(f.view.container));
        f.map.set("showEmptyLanes", false);
        await waitFor(() => expect(f.view.queryByTestId("calendar-lane-Empty")).toBeNull());
        expect(labels()).toEqual(["Blue", "Red", "Outside only", "(none)"]);
        expect(latest()).toEqual(groupedDaysDom(f.view.container));
        expect(f.context.timeZone).toBe("Asia/Tokyo");
        expect(f.map.get("timezone")).toBe("UTC");
        expect(before.content[0]).toEqual({ kind: "lane", lane: 0, label: "Red" });
    }, 45000);

    it("clears grouped evidence when switching back to the unchanged ungrouped Day path", async () => {
        const f = mountDays("day", true, true);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.doc.transact(() => {
            f.map.set("workingHoursStartMinutes", 480);
            f.map.set("workingHoursEndMinutes", 1020);
        });
        const band = () => f.view.container.querySelector<HTMLElement>(".working-hours-band")!;
        await waitFor(() => expect([band().style.top, band().style.height]).toEqual(["384px", "432px"]));
        f.doc.transact(() => {
            f.map.set("groupAxes", []);
            f.map.set("workingHoursStartMinutes", 600);
            f.map.set("workingHoursEndMinutes", 960);
        });
        await waitFor(() => {
            expect(f.view.queryByTestId("calendar-lane-time-grid")).toBeNull();
            expect([band().style.top, band().style.height]).toEqual(["480px", "288px"]);
            const value = f.results.at(-1)!;
            expect(value.ready && value.projection.modeLabel).toBe("Day");
        });
    }, 45000);

    it("commits real lane membership through the native lane-drop gesture", async () => {
        const f = mountDays("day", true, true);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        await fireEvent.dragStart(f.view.getByTestId("calendar-lane-Red").querySelector<HTMLElement>(
            `[data-testid="calendar-entry-lane-handle-outline_items:${f.early.key}"]`,
        )!);
        await fireEvent.drop(f.view.getByTestId("calendar-lane-Empty"));
        await waitFor(() => {
            expect(f.early.tags).toEqual(["Empty"]);
            const value = f.results.at(-1)!;
            expect(
                value.ready && value.projection.content.filter(item => item.title === "Early").map(item => item.lane),
            )
                .toEqual([1]);
        });
        expect(f.view.getByTestId("calendar-lane-Empty").querySelector('[aria-label="Early"]')).toBeTruthy();
        expect(f.view.getByTestId("calendar-lane-Red").querySelector('[aria-label="Early"]')).toBeNull();
        expect(f.view.getByTestId("calendar-lane-Blue").querySelector('[aria-label="Early"]')).toBeNull();
        const current = f.results.at(-1)!;
        expect(current.ready && current.projection).toEqual(groupedDaysDom(f.view.container));
    }, 45000);
});
