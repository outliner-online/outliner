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

describe("unscoped Gantt local state", () => {
    it("preserves numeric tick defaults and resets collapse on the existing mode remount boundary", async () => {
        const f = mountGantt(false, "day", false);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.map.set("ganttScale", "day");
        await waitFor(() => {
            expect(f.results.at(-1)?.ready).toBe(true);
            expect(f.view.container.querySelector(".tick-label")!.textContent).toMatch(/^\d{1,2}\/\d{1,2}$/);
        });
        const current = f.results.at(-1)!;
        expect(current.ready && ganttCssObservation(current.projection)).toEqual(ganttDom(f.view.container));
        const toggle = () => f.view.getByTestId(`calendar-gantt-collapse-outline_items:${f.parent.key}`);
        await fireEvent.click(toggle());
        await waitFor(() => expect(toggle().textContent).toBe("▸"));
        expect(f.view.queryByText("Grandchild", { selector: ".label-text" })).toBeNull();
        f.map.set("viewType", "week");
        await waitFor(() => expect(f.view.queryByTestId("calendar-gantt-chart")).toBeNull());
        f.map.set("viewType", "gantt");
        await waitFor(() => {
            expect(f.results.at(-1)?.ready).toBe(true);
            expect(toggle().textContent).toBe("▾");
            expect(f.view.getByText("Grandchild", { selector: ".label-text" })).toBeTruthy();
        });
        const value = f.results.at(-1)!;
        expect(value.ready && ganttCssObservation(value.projection)).toEqual(ganttDom(f.view.container));
        await fireEvent.click(toggle());
        await waitFor(() => expect(toggle().textContent).toBe("▸"));
    }, 45000);
});
