import { deriveCalendarMonthVisibleModel } from "$shared/notifications/calendarMonthVisibleModel";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Project } from "../../schema/app-schema";
import { monthEvidence } from "../../tests/fixtures/calendarMonthAcceptedEvidence";

describe("shared accepted Month producer", () => {
    it("uses the coherent padded range, first-value lane filter and actual painted cell semantics", () => {
        const input = monthEvidence();
        input.result.rows.push({ ...input.result.rows[0], id: "multi", title: "Multiple", team: '["Red","Blue"]' });
        const result = deriveCalendarMonthVisibleModel(input);
        if (!result.ready) throw Error(result.reason);
        expect(result.model.cells).toHaveLength(35);
        expect(result.model.laneOptions).toEqual(["Red", "Empty", "Blue"]);
        expect(result.model.projection.modeLabel).toBe("Month");
        expect(result.model.projection.content.find(value => value.title === "Red entry"))
            .toEqual({ kind: "entry", cell: 1, order: 0, title: "Red entry", background: "#dc2626" });
        const blue = deriveCalendarMonthVisibleModel({
            ...input,
            context: { ...input.context, monthLaneFilter: "Blue" },
        });
        expect(
            blue.ready
                && blue.model.projection.content.filter(value => value.kind === "entry").map(value => value.title),
        )
            .toEqual(["Hidden blue"]); // Month intentionally uses the first membership, unlike duplicated lane bands.
        expect(Object.isFrozen(result.model.projection.content[0])).toBe(true);
    });

    it("ignores hidden payload/key churn and within-cell timing, but observes displayed changes", () => {
        const input = monthEvidence();
        const projection = () => {
            const value = deriveCalendarMonthVisibleModel(input);
            if (!value.ready) throw Error(value.reason);
            return value.model.projection;
        };
        const before = projection();
        input.result.rows[1] = {
            ...input.result.rows[1],
            id: "new",
            source_id: "new",
            title: "Changed hidden text",
            unused: 42,
        };
        expect(projection()).toEqual(before);
        input.result.rows[0].start_value = "2026-04-01T02:00:00Z";
        expect(projection()).toEqual(before);
        input.result.rows[0].title = "Changed visible title";
        expect(projection()).not.toEqual(before);
        input.result.rows[0].start_value = "2026-04-02T12:00:00Z";
        const moved = deriveCalendarMonthVisibleModel(input);
        expect(
            moved.ready && moved.model.projection.content.find(value => value.title === "Changed visible title")?.cell,
        )
            .toBe(3);
    });

    it("admits known empty lanes and complete empty results, but holds unavailable selections", () => {
        const input = monthEvidence();
        input.context = { ...input.context, monthLaneFilter: "Empty" };
        input.result.rows = [];
        const empty = deriveCalendarMonthVisibleModel(input);
        expect(empty.ready && empty.model.projection.content.filter(value => value.kind === "entry")).toEqual([]);
        expect(empty.ready && empty.model.cells).toHaveLength(35);
        input.settings.showEmptyLanes = false;
        expect(deriveCalendarMonthVisibleModel(input)).toEqual({
            ready: false,
            reason: "Selected Month lane is unavailable.",
        });
        input.settings.groupAxes = [];
        expect(deriveCalendarMonthVisibleModel(input).ready).toBe(false);
        input.context = { ...input.context, monthLaneFilter: null };
        expect(deriveCalendarMonthVisibleModel(input).ready).toBe(true);
    });

    it.each(["missing column", "duplicate column", "missing cell", "undefined cell", "inherited cell"])(
        "holds %s group evidence",
        failure => {
            const input = monthEvidence();
            if (failure === "missing column") input.result.columns = [];
            if (failure === "duplicate column") input.result.columns.push("team");
            if (failure === "missing cell") delete input.result.rows[0].team;
            if (failure === "undefined cell") input.result.rows[0].team = undefined;
            if (failure === "inherited cell") {
                delete input.result.rows[0].team;
                Object.setPrototypeOf(input.result.rows[0], { team: "Red" });
            }
            expect(deriveCalendarMonthVisibleModel(input)).toEqual({
                ready: false,
                reason: "Calendar grouping evidence is unavailable or ambiguous.",
            });
        },
    );

    it("accepts explicit NULL but holds ambiguous rendered lane labels", () => {
        const input = monthEvidence();
        input.result.rows[0].team = null;
        input.context = { ...input.context, monthLaneFilter: "(none)" };
        expect(deriveCalendarMonthVisibleModel(input).ready).toBe(true);
        input.result.rows[1].team = "(none)";
        expect(deriveCalendarMonthVisibleModel(input)).toEqual({
            ready: false,
            reason: "Month lane labels are ambiguous.",
        });
    });

    it("refuses stale, incoherent, invalid-zone and unresolved recurring source evidence", () => {
        const input = monthEvidence();
        expect(deriveCalendarMonthVisibleModel({ ...input, current: false })).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(
            deriveCalendarMonthVisibleModel({
                ...input,
                context: { ...input.context, rangeEndUtcMs: input.context.rangeEndUtcMs + 1 },
            }).ready,
        ).toBe(false);
        expect(deriveCalendarMonthVisibleModel({ ...input, context: { ...input.context, timeZone: "invalid" } }).ready)
            .toBe(false);
        input.result.rows[1].rrule = "FREQ=DAILY";
        expect(deriveCalendarMonthVisibleModel({ ...input, project: Project.fromDoc(new Y.Doc()) })).toEqual({
            ready: false,
            reason: "Calendar recurrence outline evidence is unavailable.",
        });
    });
});
