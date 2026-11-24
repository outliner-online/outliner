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

describe("Gantt accepted evidence boundaries", () => {
    it.each(["week", "month", "quarter"] as const)("uses effective %s scale/ticks rather than stored defaults",
        async scale => {
            const f = mountGantt(false, scale);
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const value = f.results.at(-1)!;
            if (!value.ready) throw Error(value.reason);
            expect(ganttCssObservation(value.projection)).toEqual(ganttDom(f.view.container));
            expect(value.projection.content[0]).toEqual({
                kind: "scale",
                label: scale[0].toUpperCase() + scale.slice(1),
            });
            expect(value.projection.labels[4]).toBe(
                scale === "week" ? "Apr 1" : scale === "month" ? "April 2026" : "Q2 2026",
            );
            expect(f.map.get("ganttScale")).toBe("quarter");
        }, 45000);

    it(
        "accepts real source edits after native navigation, including off-window visible titles and collapsed descendants",
        async () => {
            const f = mountGantt(true);
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const latest = () => {
                const value = f.results.at(-1)!;
                if (!value.ready) throw Error(value.reason);
                return value.projection;
            };
            const before = latest();
            expect(before.content.filter(item => item.kind === "row")).toHaveLength(5);
            expect(f.view.queryByText("Grandchild", { selector: ".label-text" })).toBeNull();
            expect(ganttCssObservation(before)).toEqual(ganttDom(f.view.container));
            let writes = 0;
            const observe = () => {
                writes++;
            };
            f.map.observeDeep(observe);
            try {
                f.doc.transact(() => {
                    f.outside.text = "Outside revised";
                    f.grandchild.duration = "P3D";
                });
                await fireEvent.click(f.view.getByTestId("calendar-nav-next"));
                await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
                await fireEvent.click(f.view.getByTestId("calendar-nav-prev"));
                await waitFor(() => {
                    expect(f.results.at(-1)?.ready).toBe(true);
                    expect(latest().rangeLabel).toBe(before.rangeLabel);
                    expect(latest().content.some(item => item.title === "Outside revised")).toBe(true);
                });
                const parentBar = f.view.getByTestId(`calendar-gantt-bar-outline_items:${f.parent.key}`);
                expect(parentBar.style.width).toBe("30%");
                expect(f.view.getByText("Outside revised", { selector: ".label-text" })).toBeTruthy();
                expect(latest()).not.toEqual(before);
                expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
                await fireEvent.click(f.view.getByTestId(`calendar-gantt-collapse-outline_items:${f.parent.key}`));
                await waitFor(() => expect(f.view.getByText("Grandchild", { selector: ".label-text" })).toBeTruthy());
                expect(f.view.getByTestId(`calendar-gantt-bar-outline_items:${f.grandchild.key}`).style.width).toBe(
                    "10%",
                );
                expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
                expect(writes).toBe(0);
                expect(f.context.collapsedEntryKeys).toEqual([`outline_items:${f.parent.key}`]);
            } finally {
                f.map.unobserveDeep(observe);
            }
        },
        45000,
    );

    it("holds failed SQL while preserving existing fallback rendering, then renders complete grouped Gantt evidence",
        async () => {
            const f = mountGantt();
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const before = ganttDom(f.view.container);
            f.map.set("query", "SELECT broken syntax");
            await waitFor(() => expect(f.view.getByTestId("calendar-query-error").textContent).toBeTruthy());
            expect(f.results.at(-1)).toEqual({
                ready: false,
                reason: "Accepted Calendar SQL evidence is stale or unavailable.",
            });
            // Stale bars become read-only; text, positions and row structure survive.
            expect(ganttDom(f.view.container)).toEqual(before);
            f.map.set("query", f.query);
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            f.map.set("groupAxes", ["team"]);
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            expect(f.view.getByTestId("calendar-gantt-grouped-hint")).toBeTruthy();
            expect(f.view.container.querySelector(".gantt-bar.rollup")).toBeNull();
            const grouped = f.results.at(-1)!;
            expect(grouped.ready && ganttCssObservation(grouped.projection)).toEqual(ganttDom(f.view.container));
            f.map.set("groupAxes", []);
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const recovered = f.results.at(-1)!;
            expect(recovered.ready && ganttCssObservation(recovered.projection)).toEqual(ganttDom(f.view.container));
        }, 45000);
});
