import { deriveCalendarGanttVisibleModel } from "$shared/notifications/calendarGanttVisibleModel";
import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeGanttRange, type GanttScale } from "$shared/services/calendarGridRange";
import { describe, expect, it } from "vitest";

function evidence(scale: GanttScale = "day") {
    const anchorUtcMs = Date.parse("2026-04-01T04:00:00Z");
    const range = computeGanttRange(anchorUtcMs, scale, "America/New_York");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "gantt",
        ganttScale: scale,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
    const rows: Record<string, unknown>[] = [
        {
            id: "p",
            title: "Parent",
            source_id: "p",
            source_kind: "outline_items",
            start_value: "2026-04-21T04:00:00Z",
            duration: "1 day",
        },
        {
            id: "c",
            title: "Child",
            source_id: "c",
            source_kind: "outline_items",
            parent_id: "p",
            start_value: "2026-03-30T04:00:00Z",
            duration: "5 days",
        },
        {
            id: "n",
            title: "Nested",
            source_id: "n",
            source_kind: "outline_items",
            parent_id: "p",
            start_value: "2026-04-24T04:00:00Z",
            duration: "1 day",
        },
        {
            id: "g",
            title: "Grandchild",
            source_id: "g",
            source_kind: "outline_items",
            parent_id: "n",
            start_value: "2026-04-07T04:00:00Z",
            duration: "2 days",
        },
    ];
    return {
        current: true,
        context,
        result: { columns: ["id", "title", "parent_id", "start_value", "duration", "source_id", "source_kind"], rows },
        settings: {
            name: "Gantt",
            query: "SELECT id, title, parent_id, start_value, duration, source_id, source_kind FROM outline_items",
            groupAxes: [] as string[],
            roleTitle: "title",
            roleStart: "start_value",
            roleDuration: "duration",
        },
    };
}

describe("shared accepted ungrouped Gantt producer", () => {
    it("derives recursive roll-up from descendants, preserves order/depth and applies local collapse", () => {
        const input = evidence();
        const value = deriveCalendarGanttVisibleModel(input);
        if (!value.ready) throw Error(value.reason);
        expect(value.model.layout.rows!.map(row => [row.entry.title, row.depth])).toEqual([["Parent", 0], ["Child", 1],
            ["Nested", 1], ["Grandchild", 2]]);
        expect(value.model.rowPresentations[0].barLeftPct).toBe(0);
        expect(value.model.rowPresentations[0].barWidthPct).toBeCloseTo(80 / 3, 12);
        expect(Object.isFrozen(value.model.projection.content)).toBe(true);
        input.context = { ...input.context, collapsedEntryKeys: ["outline_items:p"] };
        const folded = deriveCalendarGanttVisibleModel(input);
        expect(folded.ready && folded.model.layout.rows).toHaveLength(1);
        expect(folded.ready && folded.model.rowPresentations[0]).toEqual(value.model.rowPresentations[0]);
    });
    it.each(["day", "week", "month", "quarter"] as const)("validates coherent explicit %s context and complete empties",
        scale => {
            const input = evidence(scale);
            input.result.rows = [];
            const value = deriveCalendarGanttVisibleModel(input);
            expect(value.ready && value.model.layout.rows).toEqual([]);
            expect(value.ready && value.model.ticks.length).toBeGreaterThan(0);
            expect(
                deriveCalendarGanttVisibleModel({
                    ...input,
                    context: { ...input.context, rangeEndUtcMs: input.context.rangeEndUtcMs + 1 },
                }).ready,
            ).toBe(false);
        });
    it("holds stale SQL, grouped mode, invalid context and unresolved recurrence explicitly", () => {
        const input = evidence();
        expect(deriveCalendarGanttVisibleModel({ ...input, current: false })).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(deriveCalendarGanttVisibleModel({ ...input, settings: { ...input.settings, groupAxes: ["team"] } }))
            .toEqual({ ready: false, reason: "Grouped Gantt projection is unavailable." });
        expect(deriveCalendarGanttVisibleModel({ ...input, context: { ...input.context, timeZone: "invalid" } }).ready)
            .toBe(false);
        input.result.rows[0].rrule = "FREQ=DAILY";
        expect(deriveCalendarGanttVisibleModel(input)).toEqual({
            ready: false,
            reason: "Calendar recurrence outline evidence is unavailable.",
        });
    });
});
