import { deriveCalendarDaysVisibleModel } from "$shared/notifications/calendarDaysVisibleModel";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Project } from "../../schema/app-schema";
import { groupedDayEvidence } from "../../tests/fixtures/calendarGroupedDayAccepted";

const missing = { ready: false, reason: "Calendar grouping evidence is unavailable or ambiguous." };
const recurrence = { ready: false, reason: "Calendar recurrence outline evidence is unavailable." };

describe("accepted grouped Day boundary", () => {
    it("expands real committed recurrence, preserves ordered/empty lanes and produces the exact Day label", () => {
        const { input } = groupedDayEvidence();
        const value = deriveCalendarDaysVisibleModel(input);
        if (!value.ready) throw Error(value.reason);
        expect(value.model.projection.modeLabel).toBe("Day");
        expect(value.model.bands!.map(band => band.label)).toEqual(["Blue", "Empty", "Red"]);
        expect(value.model.bands!.map(band => band.layout.dayCount)).toEqual([1, 1, 1]);
        expect(value.model.projection.content.filter(item => item.kind === "timed")).toEqual([
            { kind: "timed", title: "Recurring", day: 0, start: 9 / 24, end: 9.5 / 24, column: 0, columns: 1, lane: 0 },
            {
                kind: "timed",
                title: "Recurring",
                day: 0,
                start: 10 / 24,
                end: 10.5 / 24,
                column: 0,
                columns: 1,
                lane: 0,
            },
            { kind: "timed", title: "Recurring", day: 0, start: 9 / 24, end: 9.5 / 24, column: 0, columns: 1, lane: 2 },
            {
                kind: "timed",
                title: "Recurring",
                day: 0,
                start: 10 / 24,
                end: 10.5 / 24,
                column: 0,
                columns: 1,
                lane: 2,
            },
        ]);
        expect(Object.isFrozen(value.model.projection.content[0])).toBe(true);
    });

    it.each(["missing column", "duplicate column", "missing cell", "undefined cell", "inherited cell"])(
        "refuses %s group evidence",
        failure => {
            const { input, row } = groupedDayEvidence();
            if (failure === "missing column") input.result.columns = input.result.columns.filter(key => key !== "team");
            if (failure === "duplicate column") input.result.columns.push("team");
            if (failure === "missing cell" || failure === "inherited cell") delete row.team;
            if (failure === "undefined cell") row.team = undefined;
            if (failure === "inherited cell") Object.setPrototypeOf(row, { team: "Red" });
            expect(deriveCalendarDaysVisibleModel(input)).toEqual(missing);
        },
    );

    it("distinguishes complete empty SQL from absent column evidence", () => {
        const { input } = groupedDayEvidence();
        input.result.rows = [];
        const value = deriveCalendarDaysVisibleModel(input);
        expect(value.ready && value.model.bands!.map(band => band.label)).toEqual(["Blue", "Empty", "Red"]);
        input.settings.showEmptyLanes = false;
        const hidden = deriveCalendarDaysVisibleModel(input);
        expect(hidden.ready && hidden.model.projection.content).toEqual([]);
        input.result.columns = [];
        expect(deriveCalendarDaysVisibleModel(input)).toEqual(missing);
    });

    it("holds stale SQL and invalid context without claiming a comparable layout", () => {
        const { input } = groupedDayEvidence();
        expect(deriveCalendarDaysVisibleModel({ ...input, current: false })).toEqual({
            ready: false,
            reason: "Accepted Calendar SQL evidence is stale or unavailable.",
        });
        expect(
            deriveCalendarDaysVisibleModel({
                ...input,
                context: { ...input.context, rangeEndUtcMs: input.context.rangeEndUtcMs + 1 },
            }),
        )
            .toEqual({ ready: false, reason: "Calendar range is not coherent with its anchor and view settings." });
        expect(deriveCalendarDaysVisibleModel({ ...input, context: { ...input.context, timeZone: "invalid" } }).ready)
            .toBe(false);
        expect(deriveCalendarDaysVisibleModel({ ...input, settings: { ...input.settings, groupAxes: [] } }).ready)
            .toBe(false); // ungrouped Day retains its separate existing producer
    });

    it.each(["unrelated project", "source identity", "parent identity", "source payload", "parent payload",
        "SQL parent"])(
            "holds unresolved recurring %s",
            failure => {
                const { input, source, page, row } = groupedDayEvidence();
                if (failure === "unrelated project") input.project = Project.fromDoc(new Y.Doc());
                if (failure === "source identity") source.id = "wrong";
                if (failure === "parent identity") page.id = "wrong";
                if (failure.endsWith("payload")) {
                    const key = failure.startsWith("source") ? source.key : page.key;
                    input.project.ydoc.getMap<Y.Map<unknown>>("orderedTree").get(key)!.delete("value");
                }
                if (failure === "SQL parent") row.parent_id = "wrong";
                expect(deriveCalendarDaysVisibleModel(input)).toEqual(recurrence);
            },
        );
});
