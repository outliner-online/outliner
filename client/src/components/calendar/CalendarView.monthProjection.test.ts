import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { editHiddenMonthText } from "../../tests/fixtures/calendarMonthEvidence";
import { monthDom, mountMonth } from "../../tests/fixtures/calendarMonthProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("production Month accepted renderer", () => {
    it(
        "matches saved context, ordered lanes, clipping, recurrence and real local filter changes without settings writes",
        async () => {
            const { view, results, map, context } = mountMonth();
            await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
            const latest = () => {
                const value = results.at(-1)!;
                if (!value.ready) throw Error(value.reason);
                return value.projection;
            };
            expect(latest()).toEqual(monthDom(view.container));
            expect(latest().labels.slice(0, 4)).toEqual(["All lanes", "Red", "Empty", "Blue"]);
            expect(latest().content.filter(value => value.title === "Night").map(value => value.cell)).toEqual([1]);
            expect(latest().content.filter(value => value.title === "Carry").map(value => value.cell)).toEqual([0, 1,
                2]);
            expect(latest().content.filter(value => value.title === "Tail").map(value => value.cell)).toEqual([31, 32,
                33, 34]);
            expect(latest().content.filter(value => value.title === "Recurring")).toHaveLength(4);
            expect(latest().content.filter(value => value.title === "Override")).toHaveLength(1);
            expect(latest().content.find(value => value.title === "◆ Due")).toMatchObject({ kind: "due", cell: 4 });
            expect(latest().content.some(value => value.title === "Outside")).toBe(false);
            expect(latest().content.find(value => value.title === "Night")?.background).toBe("#9ca3af");
            const before = latest();
            let writes = 0;
            const observe = () => {
                writes++;
            };
            map.observeDeep(observe);
            try {
                const filter = view.getByTestId("calendar-month-lane-filter");
                await fireEvent.change(filter, { target: { value: "Blue" } });
                await waitFor(() =>
                    expect(latest().content.filter(value => value.kind === "entry").map(value => value.title)).toEqual([
                        "Hidden blue",
                    ])
                );
                expect(latest()).toEqual(monthDom(view.container));
                expect(latest()).not.toEqual(before);
                await fireEvent.change(filter, { target: { value: "Empty" } });
                await waitFor(() =>
                    expect(latest().content.filter(value => value.kind === "entry" || value.kind === "due")).toEqual([])
                );
                expect(latest().content.filter(value => value.kind === "cell")).toHaveLength(35);
                expect(latest()).toEqual(monthDom(view.container));
                await fireEvent.change(filter, { target: { value: "" } });
                await waitFor(() => expect(latest().content.some(value => value.title === "Hidden blue")).toBe(true));
                expect(latest()).toEqual(monthDom(view.container));
                expect(writes).toBe(0);
                expect(context.monthLaneFilter).toBe("Red");
                expect(map.get("viewType")).toBe("week");
            } finally {
                map.unobserveDeep(observe);
            }
        },
        45000,
    );
    it("acknowledges hidden-lane SQL edits without changing visible equality", async () => {
        const f = mountMonth();
        await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
        const before = f.results.at(-1)!;
        expect(before.ready && before.projection).toEqual(monthDom(f.view.container));
        const checkpoint = f.results.length;
        const fresh = await editHiddenMonthText(f);
        expect(fresh.result.rows.find(row => row.source_id === f.hidden.key)?.title).toBe("Changed hidden payload");
        expect(fresh.comparable.ready && fresh.comparable.model.projection).toEqual(before.ready && before.projection);
        expect(f.results.at(-1)).toEqual(before);
        expect(before.ready && before.projection).toEqual(monthDom(f.view.container));
        console.info("month-hidden-evidence", JSON.stringify({
            acknowledgedSQLTitle: fresh.result.rows.find(row => row.source_id === f.hidden.key)?.title,
            freshComparableReady: fresh.comparable.ready,
            nativePublications: f.results.length - checkpoint,
        }));
    }, 45000);
});
