import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { monthDom, mountMonth } from "../../tests/fixtures/calendarMonthProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("Month committed evidence and interactive fallback", () => {
    it("commits a real keyboard move and retains writable lane colors", async () => {
        const { view, results, selected, map } = mountMonth(true);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const latest = () => {
            const value = results.at(-1)!;
            if (!value.ready) throw Error(value.reason);
            return value.projection;
        };
        expect(latest()).toEqual(monthDom(view.container));
        expect(latest().content.find(value => value.title === "Night")).toMatchObject({
            cell: 1,
            background: "#dc2626",
        });
        const before = latest();
        await fireEvent.keyDown(view.getByTestId(`calendar-entry-outline_items:${selected.key}`), {
            key: "ArrowRight",
        });
        await waitFor(() => expect(selected.start).toBe("2026-04-02T03:30:00.000Z"));
        await waitFor(() =>
            expect(
                view.getByTestId("calendar-month-cell-2").querySelector(
                    `[data-testid="calendar-entry-outline_items:${selected.key}"]`,
                ),
            ).toBeTruthy()
        );
        expect(latest()).toEqual(before); // Optimistic movement is not newly accepted SQL.
        await fireEvent.click(view.getByTestId("calendar-nav-next"));
        await waitFor(() => expect(results.at(-1)?.ready && latest().rangeLabel).not.toBe(before.rangeLabel));
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        await fireEvent.click(view.getByTestId("calendar-nav-prev"));
        await waitFor(() =>
            expect(results.at(-1)?.ready && latest().content.find(value => value.title === "Night")?.cell).toBe(2)
        );
        expect(latest()).not.toEqual(before);
        expect(latest()).toEqual(monthDom(view.container));
        await fireEvent.change(view.getByTestId("calendar-month-lane-filter"), { target: { value: "Blue" } });
        await waitFor(() =>
            expect(latest().content.find(value => value.title === "Hidden blue")?.background).toBe("#16a34a")
        );
        expect(latest()).toEqual(monthDom(view.container));
        await fireEvent.change(view.getByTestId("calendar-month-lane-filter"), { target: { value: "" } });
        map.set("groupAxes", []);
        await waitFor(() => expect(view.queryByTestId("calendar-month-lane-filter")).toBeNull());
        expect(latest().content.find(value => value.title === "Night")?.background).toBe("#2563eb");
        expect(latest()).toEqual(monthDom(view.container));
    }, 45000);

    it("holds missing/failed accepted evidence while retaining the interactive display, then recovers", async () => {
        const { view, results, map, query } = mountMonth();
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const before = monthDom(view.container);
        map.set("query", "SELECT broken syntax");
        await waitFor(() => expect(view.getByTestId("calendar-query-error").textContent).toBeTruthy());
        expect(results.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(monthDom(view.container)).toEqual(before);
        map.set("query", query);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        map.set("groupAxes", ["missing_group"]);
        await waitFor(() =>
            expect(results.at(-1)).toEqual({
                ready: false,
                reason: "Calendar grouping evidence is unavailable or ambiguous.",
            })
        );
        expect(view.getAllByTestId(/calendar-month-cell-/)).toHaveLength(35);
        expect(view.queryByTestId("calendar-query-error")).toBeNull();
        map.set("groupAxes", ["team"]);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const recovered = results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(monthDom(view.container));
        expect(monthDom(view.container)).toEqual(before);
        map.set("showEmptyLanes", false);
        await waitFor(() => expect(view.queryByRole("option", { name: "Empty" })).toBeNull());
        const current = results.at(-1)!;
        expect(current.ready && current.projection).toEqual(monthDom(view.container));
    }, 45000);
});
