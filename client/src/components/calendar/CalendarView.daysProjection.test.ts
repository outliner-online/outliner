import { cleanup, configure, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { daysDom, mountDays } from "../../tests/fixtures/calendarDaysProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});

it("recaptures normal Week range evidence immediately when committed week start changes", async () => {
    const { view, results, map } = mountDays("week", false);
    await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
    const before = daysDom(view.container);
    const firstWeekday = () =>
        new Date(view.getByTestId("calendar-day-header-0").getAttribute("data-date")!)
            .getUTCDay();
    expect(firstWeekday()).toBe(0);
    map.set("weekStart", 1);
    // A cached old range cannot remain authoritative during the new query.
    expect(results.at(-1)).toEqual({ ready: false, reason: "Accepted Calendar SQL evidence is stale or unavailable." });
    await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
    expect(firstWeekday()).toBe(1);
    const accepted = results.at(-1)!;
    expect(accepted.ready && accepted.projection).toEqual(daysDom(view.container));
    expect(accepted.ready && accepted.projection.rangeLabel).not.toBe(before.rangeLabel);
}, 45000);
afterAll(resetPgliteForTests);

describe.each(["days", "week"] as const)("production %s accepted projection", viewType => {
    it("matches actual Tokyo columns, overlap width, clipping, recurrence and committed role/band edits", async () => {
        const { view, results, map } = mountDays(viewType);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const latest = () => {
            const result = results.at(-1)!;
            if (!result.ready) throw Error(result.reason);
            return result.projection;
        };
        expect(latest()).toEqual(daysDom(view.container));
        expect(latest().labels).toHaveLength((viewType === "days" ? 3 : 7) + 24);
        expect(latest().labels.at(-1)).toBe("23:00");
        expect(view.getAllByTestId(/^calendar-day-column-/)).toHaveLength(viewType === "days" ? 3 : 7);
        expect(view.getByTestId("calendar-day-header-0").getAttribute("data-date")).toBe("2026-03-16");
        expect(view.getByTestId(`calendar-day-header-${viewType === "days" ? 2 : 6}`).getAttribute("data-date"))
            .toBe(viewType === "days" ? "2026-03-18" : "2026-03-22");
        expect(latest().content.find(value => value.title === "Early")).toEqual({
            kind: "timed",
            title: "Early",
            day: 0,
            start: 15 / 1440,
            end: 75 / 1440,
            column: 0,
            columns: 2,
        });
        expect(latest().content.find(value => value.title === "Overlap"))
            .toMatchObject({ day: 0, start: 30 / 1440, end: 90 / 1440, column: 1, columns: 2 });
        expect(latest().content.find(value => value.title === "Clipped"))
            .toMatchObject({ day: 2, start: 1410 / 1440, end: 1 });
        expect(latest().content.find(value => value.title === "Carry"))
            .toEqual({ kind: "all-day", title: "Carry", day: 0, span: 2 });
        expect(latest().content.find(value => value.kind === "due")).toEqual({ kind: "due", title: "◆ Due", day: 1 });
        expect(
            latest().content.filter(value => value.title === "Recurring").map(value => Number(value.day)).sort((a, b) =>
                a - b
            ),
        )
            .toEqual([0, 1, 2]);
        expect(latest().content.filter(value => value.title === "Week only")).toHaveLength(viewType === "week" ? 1 : 0);
        expect(JSON.stringify(latest())).not.toContain("Outside");
        expect(Object.isFrozen(latest().content[0])).toBe(true);

        // Real committed settings change both products without a new SQL definition.
        map.set("roleTitle", "alternate_title");
        map.set("workingHoursStartMinutes", 570);
        await waitFor(() => expect(view.getByRole("group", { name: "Early revised" })).toBeTruthy());
        await waitFor(() => expect(latest().content.some(value => value.title === "Early revised")).toBe(true));
        expect(latest()).toEqual(daysDom(view.container));
        expect(latest().content.find(value => value.kind === "working-hours"))
            .toMatchObject({ start: 570, end: 1080 });
    }, 45000);

    it("revokes ready on real SQL failure while retaining interactive stale layout, then recovers", async () => {
        const { view, results, map, query } = mountDays(viewType);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const before = daysDom(view.container);
        map.set("query", "SELECT broken syntax");
        await waitFor(() => expect(view.getByTestId("calendar-query-error").textContent).toBeTruthy());
        expect(results.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(view.getByTestId("calendar-stale-result")).toBeTruthy();
        expect(daysDom(view.container)).toEqual(before);
        map.set("query", query);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const recovered = results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(daysDom(view.container));
    }, 45000);

    it("retains the separate grouped lane renderer with explicit non-ready projection", async () => {
        const { view, results, map } = mountDays(viewType);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        map.set("groupAxes", ["team"]);
        await waitFor(() => expect(view.getByTestId("calendar-lane-time-grid")).toBeTruthy());
        expect(results.at(-1)).toEqual({ ready: false, reason: "Grouped Days/Week projection is not ready." });
        expect(view.getByRole("group", { name: "Early" })).toBeTruthy();
        map.set("groupAxes", []);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        const recovered = results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(daysDom(view.container));
    }, 45000);
});
