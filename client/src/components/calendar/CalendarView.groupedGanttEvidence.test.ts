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

describe("grouped Gantt evidence and parked local collapse", () => {
    it("restores parked collapse when grouping is switched off and collapse itself writes no settings", async () => {
        const f = mountGantt(true);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        const before = f.results.at(-1)!;
        expect(f.view.queryByText("Grandchild", { selector: ".label-text" })).toBeNull();
        f.map.set("groupAxes", ["team"]);
        await waitFor(() => {
            expect(f.results.at(-1)?.ready).toBe(true);
            expect(f.view.getByTestId("calendar-gantt-grouped-hint")).toBeTruthy();
            expect(f.view.getByText("Grandchild", { selector: ".label-text" })).toBeTruthy();
        });
        expect(f.view.container.querySelectorAll(".collapse-toggle,.gantt-bar.rollup")).toHaveLength(0);
        f.map.set("groupAxes", []);
        await waitFor(() => expect(f.results.at(-1)).toEqual(before));
        expect(f.view.queryByText("Grandchild", { selector: ".label-text" })).toBeNull();
        const restored = f.results.at(-1)!;
        expect(restored.ready && ganttCssObservation(restored.projection)).toEqual(ganttDom(f.view.container));
        let writes = 0;
        const observe = () => {
            writes++;
        };
        f.map.observeDeep(observe);
        try {
            await fireEvent.click(f.view.getByTestId(`calendar-gantt-collapse-outline_items:${f.parent.key}`));
            await waitFor(() => expect(f.view.getByText("Grandchild", { selector: ".label-text" })).toBeTruthy());
            const current = f.results.at(-1)!;
            expect(current.ready && ganttCssObservation(current.projection)).toEqual(ganttDom(f.view.container));
            expect(writes).toBe(0);
            expect(f.context.collapsedEntryKeys).toEqual([`outline_items:${f.parent.key}`]);
        } finally {
            f.map.unobserveDeep(observe);
        }
    }, 45000);

    it("accepts complete empty SQL but holds missing/ambiguous group evidence and recovers", async () => {
        const f = mountGantt();
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.map.set("groupAxes", ["team"]);
        await waitFor(() =>
            expect(f.results.at(-1)?.ready && f.view.container.querySelectorAll(".lane-section").length).toBe(1)
        );
        const missing = { ready: false, reason: "Calendar grouping evidence is unavailable or ambiguous." };
        f.map.set("groupAxes", ["missing_group"]);
        await waitFor(() => expect(f.results.at(-1)).toEqual(missing));
        expect(f.view.getByTestId("calendar-gantt-grouped-hint")).toBeTruthy();
        expect(f.view.container.querySelectorAll(".gantt-row")).toHaveLength(10);
        f.map.set("groupAxes", ["team"]);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.map.set("query", `SELECT *, 'ambiguous'::text AS team FROM (${f.query}) AS grouped_rows`);
        await waitFor(() => expect(f.results.at(-1)).toEqual(missing));
        f.map.set("query", `SELECT * FROM (${f.query}) AS grouped_rows WHERE false`);
        await waitFor(() => {
            expect(f.results.at(-1)?.ready).toBe(true);
            expect(f.view.container.querySelectorAll(".lane-section,.gantt-row")).toHaveLength(0);
        });
        expect(f.view.getByTestId("calendar-gantt-grouped-hint")).toBeTruthy();
        expect(f.view.container.querySelectorAll(".tick-label")).toHaveLength(30);
        const empty = f.results.at(-1)!;
        expect(empty.ready && ganttCssObservation(empty.projection)).toEqual(ganttDom(f.view.container));
        f.map.set("query", f.query);
        await waitFor(() =>
            expect(f.results.at(-1)?.ready && f.view.container.querySelectorAll(".lane-section").length).toBe(1)
        );
        const recovered = f.results.at(-1)!;
        expect(recovered.ready && ganttCssObservation(recovered.projection)).toEqual(ganttDom(f.view.container));
    }, 45000);
});
