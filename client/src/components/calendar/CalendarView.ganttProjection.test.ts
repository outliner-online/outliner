import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { ganttCssObservation, ganttDom } from "../../tests/fixtures/calendarGanttDom";
import { mountGantt } from "../../tests/fixtures/calendarGanttProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("production accepted ungrouped Gantt", () => {
    it("matches literal hierarchy, recursive roll-ups, clipping, minimum width, points/due and local collapse",
        async () => {
            const f = mountGantt();
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const latest = () => {
                const value = f.results.at(-1)!;
                if (!value.ready) throw Error(value.reason);
                return value.projection;
            };
            expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
            expect(latest().content.filter(item => item.kind === "row").map(item => [item.title, item.depth])).toEqual([
                ["Parent", 0],
                ["Early", 1],
                ["Point", 1],
                ["Nested", 1],
                ["Grandchild", 2],
                ["Due", 1],
                ["Tiny", 0],
                ["Recurring", 0],
                ["Recurring", 0],
                ["Outside", 0],
            ]);
            const bar = (key: string) => f.view.getByTestId(`calendar-gantt-bar-outline_items:${key}`);
            expect(parseFloat(bar(f.parent.key).style.left)).toBe(0);
            expect(bar(f.parent.key).style.width).toBe("26.6667%");
            expect(parseFloat(bar(f.nested.key).style.left)).toBe(20);
            expect(bar(f.nested.key).style.width).toBe("6.66667%");
            expect(
                f.view.getByText("Tiny", { selector: ".label-text" }).closest(".gantt-row")!.querySelector<HTMLElement>(
                    ".gantt-bar",
                )!.style.width,
            ).toBe("0.5%");
            expect(
                f.view.getByText("Outside", { selector: ".label-text" }).closest(".gantt-row")!.querySelector<
                    HTMLElement
                >(".gantt-bar")!.style.width,
            ).toBe("0%");
            expect(latest().content.find(item => item.kind === "point")).toMatchObject({
                title: "● Point",
                left: 13.333333333333334,
            });
            expect(latest().content.filter(item => item.kind === "due").map(item => item.left)).toEqual([
                36.666666666666664,
                33.33333333333333,
            ]);
            expect(latest().labels.slice(4, 7)).toEqual(["Apr 1", "Apr 2", "Apr 3"]);
            expect(Object.isFrozen(latest().content[0])).toBe(true);
            expect(latest().content.find(item => item.kind === "bar" && item.title === "Parent")?.width).toBeCloseTo(
                80 / 3,
                12,
            );
            const before = latest();
            let writes = 0;
            const observe = () => {
                writes++;
            };
            f.map.observeDeep(observe);
            try {
                await fireEvent.click(f.view.getByTestId(`calendar-gantt-collapse-outline_items:${f.parent.key}`));
                await waitFor(() => expect(latest().content.filter(item => item.kind === "row")).toHaveLength(5));
                expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
                expect(latest().content.find(item => item.kind === "row")).toMatchObject({
                    title: "Parent",
                    collapsed: true,
                });
                expect(bar(f.parent.key).style.width).toBe("26.6667%");
                await fireEvent.click(f.view.getByTestId(`calendar-gantt-collapse-outline_items:${f.parent.key}`));
                await waitFor(() => expect(latest()).toEqual(before));
                expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
                expect(writes).toBe(0);
                expect(f.context.collapsedEntryKeys).toEqual([]);
            } finally {
                f.map.unobserveDeep(observe);
            }
        }, 45000);
});
