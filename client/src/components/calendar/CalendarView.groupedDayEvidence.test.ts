import { cleanup, configure, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { mountDays } from "../../tests/fixtures/calendarDaysProjection";
import { editClippedTextAndRead, groupedDaysDom } from "../../tests/fixtures/calendarGroupedDaysProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("grouped Day accepted evidence", () => {
    it("holds stale/missing/ambiguous SQL evidence, retains fallback and admits complete empty SQL", async () => {
        const f = mountDays("day", true, true);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        const before = groupedDaysDom(f.view.container);
        f.map.set("query", "SELECT broken syntax");
        await waitFor(() => expect(f.view.getByTestId("calendar-query-error").textContent).toBeTruthy());
        expect(f.results.at(-1)).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(groupedDaysDom(f.view.container)).toEqual(before);
        f.map.set("query", f.query);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.map.set("groupAxes", ["missing_group"]);
        const missing = { ready: false, reason: "Calendar grouping evidence is unavailable or ambiguous." };
        await waitFor(() => expect(f.results.at(-1)).toEqual(missing));
        expect(f.view.getByTestId("calendar-lane-time-grid")).toBeTruthy();
        f.map.set("groupAxes", ["team"]);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.map.set("query", `SELECT *, 'duplicate'::text AS team FROM (${f.query}) AS grouped_rows`);
        await waitFor(() => expect(f.results.at(-1)).toEqual(missing));
        f.map.set("query", `SELECT * FROM (${f.query}) AS grouped_rows WHERE false`);
        await waitFor(() => {
            expect(f.results.at(-1)?.ready).toBe(true);
            expect(f.view.container.querySelectorAll(".timed-entry,.all-day-entry,.milestone-entry")).toHaveLength(0);
            expect(Array.from(f.view.container.querySelectorAll(".lane-header")).map(node => node.textContent!.trim()))
                .toEqual(["Red", "Empty", "Blue"]);
        });
        const declared = f.results.at(-1)!;
        expect(declared.ready && declared.projection).toEqual(groupedDaysDom(f.view.container));
        f.map.set("showEmptyLanes", false);
        await waitFor(() => expect(f.view.container.querySelectorAll(".lane-band")).toHaveLength(0));
        const empty = f.results.at(-1)!;
        expect(empty.ready && empty.projection.content).toEqual([]);
        expect(empty.ready && empty.projection.labels).toEqual([]);
        expect(empty.ready && empty.projection).toEqual(groupedDaysDom(f.view.container));
        f.doc.transact(() => {
            f.map.set("showEmptyLanes", true);
            f.map.set("query", f.query);
        });
        await waitFor(() =>
            expect(f.results.at(-1)?.ready && f.view.container.querySelectorAll(".lane-band").length)
                .toBe(5)
        );
        const recovered = f.results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(before);
    }, 45000);

    it("refuses accepted SQL with a mismatched recurring parent and recovers", async () => {
        const f = mountDays("day", true, true);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        f.map.set("query", `SELECT grouped_rows.*, 'missing'::text AS parent_id FROM (${f.query}) AS grouped_rows`);
        await waitFor(() => expect(f.results.at(-1)).toEqual({
            ready: false,
            reason: "Calendar recurrence outline evidence is unavailable.",
        }));
        expect(f.view.getByTestId("calendar-lane-Red").querySelector('[aria-label="Recurring"]')).toBeTruthy();
        f.map.set("query", f.query);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        const recovered = f.results.at(-1)!;
        expect(recovered.ready && recovered.projection).toEqual(groupedDaysDom(f.view.container));
    }, 45000);

    it("acknowledges an invisible source edit in real SQL while visible output stays equal", async () => {
        const f = mountDays("day", true, true);
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        const before = f.results.at(-1)!;
        const checkpoint = f.results.length;
        const fresh = await editClippedTextAndRead(f, "Changed invisible Day payload");
        expect(fresh.result.rows.find(row => row.source_id === f.outside.key)?.title).toBe(
            "Changed invisible Day payload",
        );
        expect(fresh.comparable.ready && fresh.comparable.model.projection).toEqual(before.ready && before.projection);
        expect(f.results.at(-1)).toEqual(before);
        expect(f.results.length - checkpoint).toBe(0);
        expect(before.ready && before.projection).toEqual(groupedDaysDom(f.view.container));
        console.info("grouped-Day-clipped-evidence", JSON.stringify({
            rawSQLTitle: fresh.result.rows.find(row => row.source_id === f.outside.key)?.title,
            freshComparableReady: fresh.comparable.ready,
            nativePublications: f.results.length - checkpoint,
        }));
    }, 45000);
});
