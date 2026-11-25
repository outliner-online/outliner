import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { ganttCssObservation, ganttDom } from "../../tests/fixtures/calendarGanttDom";
import { groupedGanttFixture } from "../../tests/fixtures/calendarGroupedGanttProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("production grouped Gantt concrete lanes", () => {
    it("preserves raw first-seen lanes, chronological flat rows, NULL last and lane-local repeated-source geometry",
        async () => {
            const f = groupedGanttFixture();
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            f.activate();
            const latest = () => {
                const value = f.results.at(-1)!;
                if (!value.ready) throw Error(value.reason);
                return value.projection;
            };
            await waitFor(() =>
                expect(f.results.at(-1)?.ready && latest().content.filter(item => item.kind === "lane")).toHaveLength(4)
            );
            expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
            const sections = () => Array.from(f.view.container.querySelectorAll<HTMLElement>(".lane-section"));
            expect(sections().map(lane => lane.querySelector(".lane-header")!.textContent!.trim())).toEqual(["B", "A",
                '["Red","Blue"]', "(none)"]);
            expect(
                sections().map(lane =>
                    Array.from(lane.querySelectorAll(".label-text")).map(node => node.textContent!.trim())
                ),
            )
                .toEqual([["Parent", "Outside"], ["Grandchild"], ["Nested"], ["Grandchild", "Parent"]]);
            expect(f.view.container.querySelectorAll(".collapse-toggle,.gantt-bar.rollup")).toHaveLength(0);
            expect(
                latest().content.filter(item => item.kind === "row").every(item =>
                    item.depth === 0 && !item.hasChildren && !item.collapsed
                ),
            ).toBe(true);
            const selector = `[data-testid="calendar-gantt-bar-outline_items:${f.parent.key}"]`;
            expect(f.view.container.querySelectorAll(selector)).toHaveLength(3);
            const b = sections()[0].querySelector<HTMLElement>(selector)!;
            const a = sections()[1].querySelector<HTMLElement>(selector)!;
            expect([b.style.left, b.style.width]).toEqual(["66.6667%", "3.33333%"]);
            expect([a.style.left, a.style.width]).toEqual(["20%", "6.66667%"]);
            expect(
                sections()[0].querySelector<HTMLElement>(
                    `[data-testid="calendar-gantt-bar-outline_items:${f.outside.key}"]`,
                )!.style.width,
            ).toBe("0%");
            const before = latest();
            f.map.set("laneOrder", ["A", "New empty", "B"]);
            f.map.set("showEmptyLanes", false);
            await waitFor(() => expect(latest()).toEqual(before));
            expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
            f.outside.text = "Outside revised";
            await fireEvent.click(f.view.getByTestId("calendar-nav-next"));
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            await fireEvent.click(f.view.getByTestId("calendar-nav-prev"));
            await waitFor(() => {
                expect(f.results.at(-1)?.ready).toBe(true);
                expect(latest().rangeLabel).toBe(before.rangeLabel);
                expect(latest().content.some(item => item.title === "Outside revised")).toBe(true);
            });
            expect(latest()).not.toEqual(before);
            expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
            expect(
                sections()[0].querySelector<HTMLElement>(
                    `[data-testid="calendar-gantt-bar-outline_items:${f.outside.key}"]`,
                )!.style.width,
            ).toBe("0%");
            const retainedB = sections()[0].querySelector<HTMLElement>(selector)!;
            f.map.set("query", f.reverseGroupQuery);
            await waitFor(() => {
                expect(f.results.at(-1)?.ready).toBe(true);
                expect(sections().map(section => section.querySelector(".lane-header")!.textContent!.trim()))
                    .toEqual(['["Red","Blue"]', "B", "A", "(none)"]);
            });
            expect(sections()[1].querySelector(selector)).toBe(retainedB);
            expect(sections()[1].querySelector<HTMLElement>(selector)!.style.left).toBe("66.6667%");
            expect(sections()[2].querySelector<HTMLElement>(selector)!.style.left).toBe("20%");
            expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
        }, 45000);
});
