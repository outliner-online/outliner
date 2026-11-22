import { cleanup, configure, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { hoursDom, mountHours } from "../../tests/fixtures/calendarHoursProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("production Hours accepted-evidence projection", { timeout: 45000 }, () => {
    it("matches real DST rows, folded/overlap/clipped fragments, bands and recurrence override DOM", async () => {
        const { view, results, map } = mountHours();
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const latest = () => {
            const result = results.at(-1)!;
            if (!result.ready) throw Error(result.reason);
            return result.projection;
        };
        expect(latest()).toEqual(hoursDom(view.container));
        expect(latest().labels).toHaveLength(28); // day + four minute ticks + 23 DST hour rows
        expect(latest().labels).not.toContain("02");
        const fragments = latest().content.filter(value => value.kind === "fragment");
        expect(
            fragments.filter(value => String(value.label).startsWith("Folded")).map(
                value => [value.row, value.start, value.end, value.lane, value.lanes],
            ),
        ).toEqual([[8, 45, 60, 0, 1], [9, 0, 60, 0, 2], [10, 0, 20, 0, 1]]);
        expect(fragments.find(value => value.label === "Overlap")).toMatchObject({
            row: 9,
            start: 0,
            end: 15,
            lane: 1,
        });
        expect(fragments.find(value => value.label === "Clipped")).toMatchObject({ row: 22, start: 30, end: 60 });
        expect(latest().content.filter(value => value.kind === "all-day" || value.kind === "due"))
            .toEqual([{ kind: "all-day", title: "All day" }, { kind: "due", title: "Due" }]);
        expect(fragments.filter(value => value.label === "Actual override")).toHaveLength(1);
        expect(JSON.stringify(latest())).not.toMatch(/Hidden next day|Replaced occurrence/);
        expect(Object.isFrozen(latest())).toBe(true);
        expect(Object.isFrozen(latest().content[0])).toBe(true);

        // A cached projection or an uncoupled renderer cannot pass this role-only edit.
        map.set("roleTitle", "alternate_title");
        map.set("workingHoursStartMinutes", 9 * 60 + 30);
        await waitFor(() => expect(view.getByRole("group", { name: "Folded revised" })).toBeTruthy());
        await waitFor(() => expect(latest().content.some(value => value.title === "Folded revised")).toBe(true));
        expect(latest()).toEqual(hoursDom(view.container));
        expect(latest().content.find(value => value.kind === "hour-row" && value.label === "09"))
            .toMatchObject({ workingStart: 30, workingEnd: 60 });
    });

    it("revokes accepted observation on SQL failure while retaining stale display, then recovers", async () => {
        const { view, results, map, query, folded } = mountHours();
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        map.set("query", "SELECT broken syntax");
        await waitFor(() => expect(view.getByTestId("calendar-query-error").textContent).toBeTruthy());
        expect(results.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(view.getByTestId(`calendar-entry-item:${folded.key}`).textContent).toContain("Folded");
        expect(view.getByTestId("calendar-stale-result")).toBeTruthy();
        map.set("query", query);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const recovered = results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(hoursDom(view.container));
    });
});
