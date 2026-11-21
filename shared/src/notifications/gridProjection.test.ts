import { describe, expect, it } from "vitest";
import { type GridProjectionInput, parseGridObservationContext, projectGridTable } from "./gridProjection";

const base = (): GridProjectionInput => ({
    title: "People",
    context: { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" },
    columns: ["id", "active", "birthday", "secret"],
    rows: [{ id: "same", active: "true", birthday: "2026-11-21T23:00:00Z", secret: "a" }, {
        id: "same",
        active: true,
        birthday: "2026-11-21",
        secret: "b",
    }],
    rowTargets: [{ logicalRowId: "one" }, { logicalRowId: "two" }],
    columnOrder: ["active", "birthday", "id"],
    hiddenColumns: { secret: true },
    columnLabels: { active: "Enabled" },
    componentTypes: {},
    resultColumns: [{ name: "id", typeId: 25 }, { name: "active", typeId: 16 }, { name: "birthday", typeId: 1082 }, {
        name: "secret",
        typeId: 25,
    }],
    physicalColumns: [],
    metadataStatus: "relation-free",
});

describe("Grid table projection", () => {
    it("accepts only the supported standalone table context", () => {
        expect(parseGridObservationContext(undefined)).toEqual({ status: "none" });
        expect(
            parseGridObservationContext(
                JSON.stringify({ version: 1, surface: "table", locale: "en-US", timeZone: "UTC" }),
            ),
        )
            .toMatchObject({ status: "supported", context: { surface: "table" } });
        expect(
            parseGridObservationContext(
                JSON.stringify({ version: 1, surface: "chart", locale: "en-US", timeZone: "UTC" }),
            ),
        )
            .toMatchObject({ status: "unsupported" });
        expect(
            parseGridObservationContext(
                JSON.stringify({ version: 1, surface: "table", locale: "en-US", timeZone: "UTC", sql: "select 1" }),
            ),
        )
            .toMatchObject({ status: "unsupported" });
    });
    it("projects ordered visible content and normalizes actual cell semantics", () => {
        const result = projectGridTable(base());
        expect(result).toEqual({
            status: "ready",
            projection: {
                kind: "grid",
                title: "People",
                columns: [{ label: "Enabled" }, { label: "birthday" }, { label: "id" }],
                rows: [
                    [{ kind: "checkbox", checked: true }, { kind: "date", value: "2026-11-21" }, {
                        kind: "text",
                        value: "same",
                    }],
                    [{ kind: "checkbox", checked: true }, { kind: "date", value: "2026-11-21" }, {
                        kind: "text",
                        value: "same",
                    }],
                ],
            },
        });
        expect(result.status === "ready" && Object.isFrozen(result.projection.rows[0])).toBe(true);
    });

    it("preserves duplicate multiplicity while ignoring hidden and identity churn", () => {
        const first = projectGridTable(base());
        const changed: any = base();
        changed.rows[0] = { ...changed.rows[0], secret: "changed" };
        changed.rowTargets = [{ logicalRowId: "replacement" }, { logicalRowId: "other" }];
        expect(projectGridTable(changed)).toEqual(first);
        changed.rows = changed.rows.slice(0, 1);
        changed.rowTargets = changed.rowTargets.slice(0, 1);
        expect(projectGridTable(changed)).not.toEqual(first);
    });

    it("refuses incomplete evidence but distinguishes an authoritative empty result", () => {
        expect(projectGridTable({ ...base(), metadataStatus: "partial" })).toEqual({
            status: "unavailable",
            reason: "Grid result or schema metadata is incomplete or stale",
        });
        expect(projectGridTable({ ...base(), rows: [], rowTargets: [] })).toMatchObject({
            status: "ready",
            projection: { rows: [] },
        });
    });

    it("selects occurrence-aligned heterogeneous fields and falls back only for authoritative ambiguity", () => {
        const input: any = base();
        input.columns = ["value"];
        input.rows = [{ value: "true" }, { value: "true" }];
        input.rowTargets = [
            { logicalRowId: "a", source: { sourceKind: "alpha", sourceId: "1" } },
            { logicalRowId: "b", source: { sourceKind: "beta", sourceId: "2" } },
        ];
        input.resultColumns = [{ name: "value", typeId: 25 }];
        input.physicalColumns = [
            {
                outputColumn: "value",
                physicalColumn: "value",
                source: { kind: "table", id: "a", sqlName: "alpha", schemaRevision: "1" },
                field: { name: "value", kind: "boolean", dataType: "boolean", isNullable: false, isPrimaryKey: false },
            },
            {
                outputColumn: "value",
                physicalColumn: "value",
                source: { kind: "table", id: "b", sqlName: "beta", schemaRevision: "1" },
                field: { name: "value", kind: "text", dataType: "text", isNullable: false, isPrimaryKey: false },
            },
        ];
        input.metadataStatus = "resolved";
        expect(projectGridTable(input)).toMatchObject({
            status: "ready",
            projection: {
                rows: [
                    [{ kind: "checkbox", checked: true }],
                    [{ kind: "text", value: "true" }],
                ],
            },
        });
    });
});
