import { describe, expect, it } from "vitest";
import {
    createKanbanVisibleProjection,
    deriveKanbanRenderModel,
    parseKanbanObservationContext,
} from "../../../../shared/src/notifications/kanbanProjection";

const context = { version: 1 as const, surface: "board" as const, locale: "en-US", timeZone: "UTC" };
const settings = {
    name: "Delivery",
    groupField: "lane",
    titleField: "title",
    detailFields: ["points"],
    laneOrder: ["doing", null],
};
const ready = { status: "ready" as const, complete: true as const, current: true as const };
const columns = ["lane", "title", "points"];

describe("Kanban visible projection", () => {
    it("preserves display order, empty lanes, special values, details, and duplicate occurrences", () => {
        const rows = [
            { lane: null, title: null, points: undefined, hidden: "one" },
            { lane: "", title: "", points: null },
            { lane: " ", title: "Same", points: 2 },
            { lane: " ", title: "Same", points: 2 },
        ];
        const result = createKanbanVisibleProjection({
            rows,
            columns,
            settings,
            declaredGroupingChoices: ["todo", "doing", ""],
            readiness: ready,
        }, context);

        expect(result).toEqual({
            status: "ready",
            content: {
                kind: "kanban",
                title: "Delivery",
                lanes: [
                    { label: "doing", kindLabel: "Text value", cards: [] },
                    {
                        label: "SQL NULL",
                        kindLabel: "SQL NULL value",
                        cards: [{ title: "NULL", details: [{ label: "points", value: "" }] }],
                    },
                    { label: "todo", kindLabel: "Text value", cards: [] },
                    {
                        label: "Empty string",
                        kindLabel: "Empty string value",
                        cards: [{ title: "Untitled", details: [{ label: "points", value: "NULL" }] }],
                    },
                    {
                        label: "Whitespace (1)",
                        kindLabel: "Text value",
                        cards: [
                            { title: "Same", details: [{ label: "points", value: "2" }] },
                            { title: "Same", details: [{ label: "points", value: "2" }] },
                        ],
                    },
                ],
            },
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.status === "ready" && result.content.lanes)).toBe(true);
    });

    it("ignores hidden data and execution identity while retaining visible multiplicity", () => {
        const input = (rows: Record<string, unknown>[]) => ({
            rows,
            columns,
            settings,
            declaredGroupingChoices: [],
            readiness: ready,
        });
        const first = createKanbanVisibleProjection(input([
            { lane: "doing", title: "A", points: 1, uuid: "old", queryId: "q1" },
        ]), context);
        const hiddenEdit = createKanbanVisibleProjection(input([
            { lane: "doing", title: "A", points: 1, uuid: "new", queryId: "q2" },
        ]), context);
        const duplicate = createKanbanVisibleProjection(input([
            { lane: "doing", title: "A", points: 1 },
            { lane: "doing", title: "A", points: 1 },
        ]), context);
        expect(hiddenEdit).toEqual(first);
        expect(duplicate).not.toEqual(first);
    });

    it("returns non-ready content for unsupported context or invalid grouping evidence", () => {
        expect(
            createKanbanVisibleProjection({
                rows: [],
                columns,
                settings,
                declaredGroupingChoices: [],
                readiness: ready,
            }, { ...context, surface: "notification" as "board" }),
        ).toEqual({ status: "non-ready", reason: "Unsupported Kanban observation context" });
        expect(createKanbanVisibleProjection({
            rows: [{ lane: 7 }],
            columns,
            settings,
            declaredGroupingChoices: [],
            readiness: ready,
        }, context)).toEqual({ status: "non-ready", reason: "Grouping values must be strings or SQL NULL" });
        expect(() => deriveKanbanRenderModel({
            rows: [],
            settings: { ...settings, groupField: undefined },
            declaredGroupingChoices: [],
        })).toThrow("Kanban grouping column is required");
        expect(createKanbanVisibleProjection({
            rows: [],
            columns,
            settings,
            declaredGroupingChoices: [],
            readiness: { status: "non-ready", reason: "stale evidence" },
        }, context)).toEqual({ status: "non-ready", reason: "stale evidence" });
    });

    it("rejects missing or duplicated configured columns even when accepted results have no rows", () => {
        const project = (resultColumns: string[], configured = settings) =>
            createKanbanVisibleProjection({
                rows: [],
                columns: resultColumns,
                settings: configured,
                declaredGroupingChoices: [],
                readiness: ready,
            }, context);

        expect(project(["title", "points"])).toEqual({
            status: "non-ready",
            reason: 'Grouping result column "lane" is missing',
        });
        expect(project(["lane", "lane", "title", "points"])).toEqual({
            status: "non-ready",
            reason: 'Grouping result column "lane" is duplicated',
        });
        expect(project(["lane", "points"])).toEqual({
            status: "non-ready",
            reason: 'Configured result column "title" is missing',
        });
        expect(project(["lane", "title"])).toEqual({
            status: "non-ready",
            reason: 'Configured result column "points" is missing',
        });
        expect(project(["lane", "title", "title", "points"])).toEqual({
            status: "non-ready",
            reason: 'Configured result column "title" is duplicated',
        });
        expect(project(["lane", "title", "points", "points"])).toEqual({
            status: "non-ready",
            reason: 'Configured result column "points" is duplicated',
        });
    });

    it("uses strict shared parsing for explicit route contexts", () => {
        expect(parseKanbanObservationContext(new URLSearchParams())).toEqual({ status: "absent" });
        expect(parseKanbanObservationContext(new URLSearchParams(
            "surface=board&version=1&locale=en-US&timeZone=UTC",
        ))).toEqual({ status: "valid", context });
        for (const query of [
            "surface=board&version=1&locale=%25%25%25&timeZone=UTC",
            "surface=board&version=1&locale=en-US&timeZone=Not%2FAZone",
            "surface=other&version=1&locale=en-US&timeZone=UTC",
        ]) {
            expect(parseKanbanObservationContext(new URLSearchParams(query))).toEqual({
                status: "invalid",
                reason: "Unsupported Kanban observation context.",
            });
        }
    });
});
