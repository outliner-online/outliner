import { deriveCalendarDaysVisibleModel } from "$shared/notifications/calendarDaysVisibleModel";
import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeViewRange } from "$shared/services/calendarGridRange";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Project } from "../../schema/app-schema";

function evidence(viewType: "days" | "week") {
    const anchorUtcMs = Date.parse("2026-03-16T00:00:00Z");
    const range = computeViewRange(anchorUtcMs, viewType, 1, "Asia/Tokyo");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "Asia/Tokyo",
        weekStart: 1,
        viewType,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
    return {
        current: true,
        context,
        settings: { name: "Calendar", groupAxes: [], roleTitle: "title", roleStart: "start" },
        result: { columns: ["title", "start"], rows: [{ title: "Accepted", start: "2026-03-16T00:00:00Z" }] },
    };
}

describe.each(["days", "week"] as const)("shared %s producer", viewType => {
    it("requires coherent explicit range/timezone and current accepted SQL", () => {
        const input = evidence(viewType);
        expect(deriveCalendarDaysVisibleModel({ ...input, current: false })).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(deriveCalendarDaysVisibleModel({
            ...input,
            context: { ...input.context, rangeEndUtcMs: input.context.rangeEndUtcMs + 1 },
        })).toEqual({ ready: false, reason: "Calendar range is not coherent with its anchor and view settings." });
        expect(deriveCalendarDaysVisibleModel({ ...input, context: { ...input.context, timeZone: "invalid" } }).ready)
            .toBe(false);
    });

    it("refuses grouped geometry and unresolved recurrence with a non-null project", () => {
        const input = evidence(viewType);
        expect(deriveCalendarDaysVisibleModel({ ...input, settings: { ...input.settings, groupAxes: ["team"] } }))
            .toEqual({ ready: false, reason: "Grouped Days/Week projection is not ready." });
        expect(deriveCalendarDaysVisibleModel({
            ...input,
            project: Project.fromDoc(new Y.Doc()),
            result: {
                columns: [],
                rows: [{
                    ...input.result.rows[0],
                    rrule: "FREQ=DAILY",
                    source_kind: "item",
                    source_id: "missing-source",
                }],
            },
        })).toEqual({ ready: false, reason: "Calendar recurrence outline evidence is unavailable." });
    });

    it("publishes the shared geometry with the mode's actual label and frozen projection", () => {
        const result = deriveCalendarDaysVisibleModel(evidence(viewType));
        expect(result.ready).toBe(true);
        if (!result.ready) throw Error(result.reason);
        expect(result.model.layout.dayCount).toBe(viewType === "days" ? 3 : 7);
        expect(result.model.projection.modeLabel).toBe(viewType === "days" ? "Multi-day" : "Week");
        expect(result.model.projection.content[0]).toEqual({
            kind: "timed",
            title: "Accepted",
            day: 0,
            start: 9 / 24,
            end: 9.5 / 24,
            column: 0,
            columns: 1,
        });
        expect(Object.isFrozen(result.model.projection.content[0])).toBe(true);
    });
});
