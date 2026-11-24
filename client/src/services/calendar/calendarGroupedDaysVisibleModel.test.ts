import { deriveCalendarDaysVisibleModel } from "$shared/notifications/calendarDaysVisibleModel";
import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { computeViewRange } from "$shared/services/calendarGridRange";
import { describe, expect, it } from "vitest";

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
    const rows: Record<string, unknown>[] = [
        { id: "both", title: "Visible", start: "2026-03-16T00:00:00Z", team: '["Red","Blue"]' },
        { id: "hidden", title: "Hidden text", start: "2026-03-23T00:00:00Z", team: "Outside only" },
        { id: "null", title: "No membership", start: "2026-03-16T01:00:00Z", team: null },
    ];
    return {
        current: true,
        context,
        settings: {
            name: "Grouped",
            roleTitle: "title",
            roleStart: "start",
            groupAxes: ["team"],
            laneOrder: ["Red", "Empty", "Blue"],
            showEmptyLanes: true,
        },
        result: { columns: ["id", "title", "start", "team"], rows },
    };
}
const missing = { ready: false, reason: "Calendar grouping evidence is unavailable or ambiguous." };

describe.each(["days", "week"] as const)("grouped %s accepted evidence", viewType => {
    it("derives ordered/empty/multiple/null lanes before clipping and refuses stale SQL", () => {
        const input = evidence(viewType);
        expect(deriveCalendarDaysVisibleModel({ ...input, current: false })).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        const result = deriveCalendarDaysVisibleModel(input);
        if (!result.ready) throw Error(result.reason);
        expect(result.model.layout).toBeUndefined();
        expect(result.model.bands?.map(band => band.label)).toEqual(["Red", "Empty", "Blue", "Outside only", "(none)"]);
        expect(result.model.bands?.find(band => band.label === "Empty")?.layout.timed).toEqual([]);
        expect(result.model.projection.content.filter(value => value.title === "Visible").map(value => value.lane))
            .toEqual([0, 2]);
        expect(JSON.stringify(result.model.projection)).not.toContain("Hidden text");
        expect(result.model.projection.content.find(value => value.label === "Outside only"))
            .toEqual({ kind: "lane", lane: 3, label: "Outside only" });
        expect(Object.isFrozen(result.model.projection.content[0])).toBe(true);
    });

    it.each(["missing column", "duplicate column", "missing cell", "undefined cell"])(
        "refuses %s instead of treating unknown membership as NULL",
        failure => {
            const input = evidence(viewType);
            if (failure === "missing column") input.result.columns = ["id", "title", "start"];
            if (failure === "duplicate column") input.result.columns.push("team");
            if (failure === "missing cell") delete input.result.rows[0].team;
            if (failure === "undefined cell") input.result.rows[0].team = undefined;
            expect(deriveCalendarDaysVisibleModel(input)).toEqual(missing);
        },
    );

    it("accepts declared empty lanes only with authoritative selected-column metadata", () => {
        const input = evidence(viewType);
        input.result.rows = [];
        input.settings.laneOrder = ["Declared empty"];
        const shown = deriveCalendarDaysVisibleModel(input);
        if (!shown.ready) throw Error(shown.reason);
        expect(shown.model.bands?.map(band => band.label)).toEqual(["Declared empty"]);
        expect(shown.model.projection.content[0]).toEqual({ kind: "lane", lane: 0, label: "Declared empty" });
        input.settings.showEmptyLanes = false;
        const omitted = deriveCalendarDaysVisibleModel(input);
        if (!omitted.ready) throw Error(omitted.reason);
        expect(omitted.model.bands).toEqual([]);
        expect(omitted.model.projection.labels).toEqual([]);
        expect(omitted.model.projection.content).toEqual([]);
        input.result.columns = [];
        expect(deriveCalendarDaysVisibleModel(input)).toEqual(missing);
    });

    it("orders unlisted values in the explicit locale and follows the rendered first-axis boundary", () => {
        const input = evidence(viewType);
        input.settings.laneOrder = [];
        input.settings.groupAxes = ["team", "unused_second_axis"];
        input.result.rows = [
            { title: "Z", team: "z" },
            { title: "Umlaut", team: "ä" },
        ];
        const swedish = deriveCalendarDaysVisibleModel({ ...input, context: { ...input.context, locale: "sv-SE" } });
        const english = deriveCalendarDaysVisibleModel(input);
        expect(swedish.ready && swedish.model.bands?.map(band => band.label)).toEqual(["z", "ä"]);
        expect(english.ready && english.model.bands?.map(band => band.label)).toEqual(["ä", "z"]);
    });
});
