import { deriveCalendarGanttVisibleModel } from "$shared/notifications/calendarGanttVisibleModel";
import { describe, expect, it } from "vitest";
import { groupedGanttEvidence } from "../../tests/fixtures/calendarGroupedGanttAccepted";

describe("accepted raw-value grouped Gantt", () => {
    it("keeps first-seen lanes, NULL/empty last, chronological flat rows and lane-local placement", () => {
        const input = groupedGanttEvidence();
        const value = deriveCalendarGanttVisibleModel(input);
        if (!value.ready) throw Error(value.reason);
        expect(value.model.layout.grouped).toBe(true);
        expect(value.model.layout.lanes!.map(lane => lane.key)).toEqual(["B", "A", '["Red","Blue"]', undefined]);
        expect(value.model.layout.lanes!.map(lane => lane.rows.map(row => row.entry.title))).toEqual([
            ["Shared B", "Outside"],
            ["Shared A"],
            ["JSON"],
            ["Null", "Empty"],
        ]);
        expect(
            value.model.layout.lanes!.flatMap(lane => lane.rows).every(row =>
                row.depth === 0 && !row.isRollup && !row.hasChildren && !row.collapsed
            ),
        ).toBe(true);
        expect(value.model.laneRowPresentations[0][0].barLeftPct).toBeCloseTo(200 / 3, 12);
        expect(value.model.laneRowPresentations[1][0].barLeftPct).toBe(20);
        expect(value.model.laneRowPresentations[0][1].barWidthPct).toBe(0);
        expect(value.model.projection.content.some(item => item.title === "Outside")).toBe(true);
        const before = value.model.projection;
        input.settings.laneOrder = ["A", "B", "New empty"];
        input.settings.showEmptyLanes = false;
        const ignored = deriveCalendarGanttVisibleModel(input);
        expect(ignored.ready && ignored.model.projection).toEqual(before);
        input.result.rows[1].title = "Outside revised";
        const edited = deriveCalendarGanttVisibleModel(input);
        expect(edited.ready && edited.model.projection).not.toEqual(before);
        expect(Object.isFrozen(before.content[0])).toBe(true);
        expect(input.context.collapsedEntryKeys).toEqual(["outline_items:p"]);
    });

    it("holds duplicate identities within one native keyed lane without rejecting cross-lane reuse", () => {
        const input = groupedGanttEvidence();
        expect(deriveCalendarGanttVisibleModel(input).ready).toBe(true);
        input.result.rows.push({ ...input.result.rows[2], team: "B" });
        expect(deriveCalendarGanttVisibleModel(input)).toEqual({
            ready: false,
            reason: "Grouped Gantt row identities are ambiguous.",
        });
    });

    it("admits complete empty results without synthesizing declared empty lanes", () => {
        const input = groupedGanttEvidence();
        input.result.rows = [];
        const value = deriveCalendarGanttVisibleModel(input);
        expect(value.ready && value.model.layout.lanes).toEqual([]);
        expect(value.ready && value.model.laneRowPresentations).toEqual([]);
        expect(value.ready && value.model.projection.content.some(item => item.kind === "grouped-hint")).toBe(true);
        input.result.columns = [];
        expect(deriveCalendarGanttVisibleModel(input)).toEqual({
            ready: false,
            reason: "Calendar grouping evidence is unavailable or ambiguous.",
        });
    });

    it.each(["missing column", "duplicate column", "missing cell", "undefined cell", "inherited cell"])(
        "holds %s group evidence",
        failure => {
            const input = groupedGanttEvidence();
            if (failure === "missing column") {
                input.result.columns = input.result.columns.filter(column => column !== "team");
            }
            if (failure === "duplicate column") input.result.columns.push("team");
            if (failure === "missing cell" || failure === "inherited cell") delete input.result.rows[0].team;
            if (failure === "undefined cell") input.result.rows[0].team = undefined;
            if (failure === "inherited cell") Object.setPrototypeOf(input.result.rows[0], { team: "B" });
            expect(deriveCalendarGanttVisibleModel(input)).toEqual({
                ready: false,
                reason: "Calendar grouping evidence is unavailable or ambiguous.",
            });
        },
    );
});
