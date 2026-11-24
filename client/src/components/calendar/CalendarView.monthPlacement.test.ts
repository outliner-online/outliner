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

describe("Month concrete placement presentation", () => {
    it("keeps independent lane colors for the same source key on two dates, in either SQL row order", async () => {
        const { view, results, map, selected, hidden } = mountMonth(true);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        await fireEvent.change(view.getByTestId("calendar-month-lane-filter"), { target: { value: "" } });
        const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
        const branch = (id: string, lane: string) =>
            "SELECT id, text AS title, all_day, start_at AS start_value, duration, "
            + `${literal(lane)} AS team, 'outline_items' AS source_kind, ${literal(selected.key)} AS source_id `
            + `FROM outline_items WHERE id = ${literal(id)}`;
        const red = branch(selected.key, "Red");
        const blue = branch(hidden.key, "Blue");
        for (const query of [`${red} UNION ALL ${blue}`, `${blue} UNION ALL ${red}`]) {
            map.set("query", query);
            await waitFor(() => {
                const value = results.at(-1);
                expect(value?.ready && value.projection.content.filter(item => item.kind === "entry")).toHaveLength(2);
            });
            const value = results.at(-1)!;
            if (!value.ready) throw Error(value.reason);
            // Parity alone passed the bad key-only cache. The independent
            // concrete DOM expectations below must also hold.
            expect(value.projection).toEqual(monthDom(view.container));
            const selector = `[data-testid="calendar-entry-outline_items:${selected.key}"]`;
            const first = view.getByTestId("calendar-month-cell-1").querySelector<HTMLElement>(selector)!;
            const second = view.getByTestId("calendar-month-cell-2").querySelector<HTMLElement>(selector)!;
            expect(first.querySelector(".chip-title")!.textContent).toBe("Night");
            expect(second.querySelector(".chip-title")!.textContent).toBe("Hidden blue");
            expect(first.style.background).toBe("rgb(220, 38, 38)");
            expect(second.style.background).toBe("rgb(22, 163, 74)");
            expect(first.dataset.lane).toBe("Red");
            expect(second.dataset.lane).toBe("Blue");
            expect(view.container.querySelectorAll(selector)).toHaveLength(2);
            expect(value.projection.content.filter(item => item.kind === "entry")).toEqual([
                { kind: "entry", cell: 1, order: 0, title: "Night", background: "#dc2626" },
                { kind: "entry", cell: 2, order: 0, title: "Hidden blue", background: "#16a34a" },
            ]);
        }
    }, 45000);
    it("keeps per-cell order, colors and keyed nodes when concrete placements reorder", async () => {
        const { view, results, map, selected, hidden } = mountMonth(true);
        await waitFor(() => expect(results.at(-1)?.ready).toBe(true));
        await fireEvent.change(view.getByTestId("calendar-month-lane-filter"), { target: { value: "" } });
        const row = (title: string, lane: string, sourceId: string) =>
            `SELECT id, '${title}' AS title, all_day, start_at AS start_value, duration, `
            + `'${lane}' AS team, 'outline_items' AS source_kind, '${sourceId}' AS source_id `
            + `FROM outline_items WHERE id = '${selected.key}'`;
        const red = row("First", "Red", selected.key);
        const blue = row("Second", "Blue", hidden.key);
        let firstNode: HTMLElement | undefined;
        for (const redFirst of [true, false]) {
            map.set("query", redFirst ? `${red} UNION ALL ${blue}` : `${blue} UNION ALL ${red}`);
            await waitFor(() => {
                const value = results.at(-1);
                expect(value?.ready && value.projection.content.filter(item => item.kind === "entry")).toHaveLength(2);
            });
            const value = results.at(-1)!;
            if (!value.ready) throw Error(value.reason);
            const chips = Array.from(
                view.getByTestId("calendar-month-cell-1").querySelectorAll<HTMLElement>(".entry-chip"),
            );
            expect(chips.map(chip => chip.querySelector(".chip-title")!.textContent))
                .toEqual(redFirst ? ["First", "Second"] : ["Second", "First"]);
            expect(chips.map(chip => chip.style.background))
                .toEqual(
                    redFirst ? ["rgb(220, 38, 38)", "rgb(22, 163, 74)"] : ["rgb(22, 163, 74)", "rgb(220, 38, 38)"],
                );
            const redNode = chips.find(chip => chip.dataset.lane === "Red")!;
            expect(redNode.dataset.testid).toBe(`calendar-entry-outline_items:${selected.key}`);
            if (firstNode) expect(redNode).toBe(firstNode);
            else firstNode = redNode;
            expect(value.projection.content.filter(item => item.kind === "entry")).toEqual([
                {
                    kind: "entry",
                    cell: 1,
                    order: 0,
                    title: redFirst ? "First" : "Second",
                    background: redFirst ? "#dc2626" : "#16a34a",
                },
                {
                    kind: "entry",
                    cell: 1,
                    order: 1,
                    title: redFirst ? "Second" : "First",
                    background: redFirst ? "#16a34a" : "#dc2626",
                },
            ]);
            expect(value.projection).toEqual(monthDom(view.container));
        }
    }, 45000);
});
