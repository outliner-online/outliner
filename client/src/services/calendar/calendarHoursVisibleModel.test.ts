import { deriveCalendarHoursVisibleModel } from "$shared/notifications/calendarHoursVisibleModel";
import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeViewRange } from "$shared/services/calendarGridRange";
import { describe, expect, it } from "vitest";

const anchorUtcMs = Date.UTC(2026, 2, 8, 16);
const range = computeViewRange(anchorUtcMs, "hours", 1, "America/New_York");
const context: CalendarObservationContextV1 = {
    version: 1,
    locale: "en-US",
    timeZone: "America/New_York",
    weekStart: 1,
    viewType: "hours",
    anchorUtcMs,
    rangeStartUtcMs: range.start,
    rangeEndUtcMs: range.end,
    monthLaneFilter: null,
    collapsedEntryKeys: [],
};
const settings = { name: "Hours", roleTitle: "title", roleStart: "start", roleDuration: "duration" };
const row = { id: "a", title: "Visible", start: "2026-03-08T13:00:00Z", duration: "00:30:00" };
const evidence = { current: true, context, settings, result: { columns: Object.keys(row), rows: [row] } };

describe("shared Hours accepted-evidence producer", () => {
    it("refuses stale, incoherent, unsupported and incomplete recurrence evidence", () => {
        expect(deriveCalendarHoursVisibleModel({ ...evidence, current: false })).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(
            deriveCalendarHoursVisibleModel({
                ...evidence,
                context: { ...context, rangeEndUtcMs: range.end + 3_600_000 },
            }).ready,
        ).toBe(false);
        expect(deriveCalendarHoursVisibleModel({ ...evidence, context: { ...context, viewType: "day" } }))
            .toEqual({ ready: false, reason: "Hours evidence requires Hours context." });
        expect(
            deriveCalendarHoursVisibleModel({
                ...evidence,
                result: { columns: ["rrule", "source_kind"], rows: [{ rrule: "FREQ=DAILY", source_kind: "item" }] },
            }),
        )
            .toEqual({ ready: false, reason: "Calendar recurrence outline evidence is unavailable." });
    });

    it("compares painted semantics rather than source keys, unused fields or clipped-out rows", () => {
        const first = deriveCalendarHoursVisibleModel(evidence);
        const second = deriveCalendarHoursVisibleModel({
            ...evidence,
            result: {
                columns: [...evidence.result.columns, "unused", "rrule", "source_kind"],
                rows: [
                    { ...row, id: "other-id", unused: "Changed", rrule: "FREQ=DAILY", source_kind: "tasks" },
                    { ...row, id: "hidden", title: "Hidden", start: "2026-03-09T13:00:00Z" },
                ],
            },
        });
        expect(first.ready).toBe(true);
        expect(second.ready).toBe(true);
        expect(second.ready && second.model.projection).toEqual(first.ready && first.model.projection);
    });
});
