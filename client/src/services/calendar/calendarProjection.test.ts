import {
    decodeCalendarObservationContext,
    encodeCalendarObservationContext,
    projectCalendarVisibleState,
    validateCalendarObservationContext,
} from "$shared/notifications/calendarProjection";
import { describe, expect, it } from "vitest";
import { computeGanttRange, computeViewRange } from "./calendarGridRange";

function context(viewType: "week" | "month" | "gantt" = "week") {
    const anchorUtcMs = Date.UTC(2026, 2, 8, 16);
    const range = viewType === "gantt"
        ? computeGanttRange(anchorUtcMs, "week", "America/New_York")
        : computeViewRange(anchorUtcMs, viewType, 1, "America/New_York");
    return {
        version: 1 as const,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: viewType === "month" ? "Team A" : null,
        collapsedEntryKeys: viewType === "gantt" ? ["parent"] : [],
        ...(viewType === "gantt" ? { ganttScale: "week" as const } : {}),
    };
}

describe("Calendar observation context", () => {
    it("round-trips a DST-spanning canonical range", () => {
        const original = context();
        const decoded = decodeCalendarObservationContext(encodeCalendarObservationContext(original));
        expect(decoded).toEqual({ valid: true, context: original });
    });

    it("survives the URLSearchParams decoding boundary exactly once", () => {
        const original = { ...context("month"), monthLaneFilter: "Sales 100% / %20" };
        const query = `context=${encodeURIComponent(encodeCalendarObservationContext(original))}`;
        const valueAfterBrowserDecode = new URLSearchParams(query).get("context");
        expect(valueAfterBrowserDecode).not.toBeNull();
        expect(decodeCalendarObservationContext(valueAfterBrowserDecode!)).toEqual({ valid: true, context: original });
        expect(decodeCalendarObservationContext("")).toMatchObject({ valid: false });
    });

    it("rejects an altered endpoint and mode-inapplicable state", () => {
        expect(validateCalendarObservationContext({ ...context(), rangeEndUtcMs: context().rangeEndUtcMs + 3_600_000 }))
            .toMatchObject({ valid: false });
        expect(validateCalendarObservationContext({ ...context(), monthLaneFilter: "hidden" })).toMatchObject({
            valid: false,
        });
    });

    it("returns non-ready instead of an authoritative empty projection", () => {
        expect(projectCalendarVisibleState(context(), undefined)).toEqual({
            ready: false,
            reason: "Authoritative Calendar visible-state evidence is unavailable.",
        });
    });
});
