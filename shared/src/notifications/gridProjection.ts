import { orderColumns } from "../services/gridDefinition.js";

export interface GridObservationContextV1 {
    readonly version: 1;
    readonly surface: "table";
    readonly locale: string;
    readonly timeZone: string;
}

export type ParsedGridObservationContext =
    | { readonly status: "none"; }
    | { readonly status: "supported"; readonly context: GridObservationContextV1; }
    | { readonly status: "unsupported"; readonly reason: string; };

/** Parses the standalone route context without accepting SQL or arbitrary data parameters. */
export function parseGridObservationContext(value: string | undefined): ParsedGridObservationContext {
    if (value === undefined) return { status: "none" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return { status: "unsupported", reason: "The Grid observation context is invalid" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "unsupported", reason: "The Grid observation context is invalid" };
    }
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["version", "surface", "locale", "timeZone"].includes(key))) {
        return { status: "unsupported", reason: "The Grid observation context contains unsupported parameters" };
    }
    if (
        record.version !== 1 || record.surface !== "table" || typeof record.locale !== "string"
        || typeof record.timeZone !== "string" || !record.locale || !record.timeZone
    ) return { status: "unsupported", reason: "Only the version-1 Grid table surface is supported" };
    try {
        new Intl.DateTimeFormat(record.locale, { timeZone: record.timeZone });
    } catch {
        return { status: "unsupported", reason: "The Grid observation locale or time zone is invalid" };
    }
    return { status: "supported", context: record as unknown as GridObservationContextV1 };
}

export type GridCellType = "text" | "number" | "checkbox" | "select" | "date";

export interface GridProjectionField {
    readonly name: string;
    readonly kind: string;
    readonly dataType: string;
    readonly isNullable: boolean;
    readonly isPrimaryKey: boolean;
    readonly enumLabels?: readonly string[];
    readonly checkOptions?: readonly string[];
}

export interface GridProjectionPhysicalColumn {
    readonly outputColumn: string;
    readonly physicalColumn: string;
    readonly source: {
        readonly kind: string;
        readonly id: string;
        readonly sqlName: string;
        readonly schemaRevision: string;
    };
    readonly field?: GridProjectionField;
}

export interface GridProjectionRowTarget {
    readonly logicalRowId: string;
    readonly source?: { readonly sourceKind: string; readonly sourceId: string; };
}

export type GridRenderedCell =
    | { readonly kind: "checkbox"; readonly checked: boolean; }
    | { readonly kind: "text" | "number" | "date" | "select"; readonly value: string; };

/** Equality content deliberately excludes renderer identity when the displayed text is unchanged. */
export type GridVisibleCell =
    | { readonly checked: boolean; }
    | { readonly value: string; };

export interface GridVisibleProjection {
    readonly kind: "grid";
    readonly title: string;
    readonly columns: readonly { readonly label: string; }[];
    readonly rows: readonly (readonly GridVisibleCell[])[];
}

export type GridProjectionResult =
    | { readonly status: "ready"; readonly projection: GridVisibleProjection; }
    | { readonly status: "unavailable"; readonly reason: string; };

export interface GridProjectionInput {
    readonly title: string;
    readonly context: GridObservationContextV1;
    readonly columns: readonly string[];
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowTargets: readonly GridProjectionRowTarget[];
    readonly columnOrder: readonly string[];
    readonly hiddenColumns: Readonly<Record<string, boolean>>;
    readonly columnLabels: Readonly<Record<string, string | undefined>>;
    readonly componentTypes: Readonly<Record<string, string | undefined>>;
    readonly resultColumns: readonly { readonly name: string; readonly typeId?: number; }[];
    readonly physicalColumns: readonly GridProjectionPhysicalColumn[];
    readonly metadataStatus: "resolved" | "relation-free" | "partial" | "unsupported" | "unavailable";
}

export function isGridCellType(value: unknown): value is GridCellType {
    return value === "text" || value === "number" || value === "checkbox" || value === "select" || value === "date";
}

export function gridCellType(configuredType: string | undefined, field: GridProjectionField | undefined): GridCellType {
    if (isGridCellType(configuredType)) return configuredType;
    if (field?.kind === "enum" || (field?.checkOptions?.length ?? 0) > 0) return "select";
    if (field?.kind === "boolean") return "checkbox";
    if (field?.kind === "integer" || field?.kind === "number") return "number";
    if (field?.kind === "date") return "date";
    return "text";
}

export function gridDisplayedCell(type: GridCellType, value: unknown): GridRenderedCell {
    if (type === "checkbox") return { kind: "checkbox", checked: value === true || value === "true" };
    const text = value === null || value === undefined ? "" : String(value);
    return { kind: type, value: type === "date" ? text.slice(0, 10) : text };
}

export function gridComparableCell(cell: GridRenderedCell): GridVisibleCell {
    return cell.kind === "checkbox" ? { checked: cell.checked } : { value: cell.value };
}

export function gridVisibleColumns(
    columns: readonly string[],
    savedOrder: readonly string[],
    hidden: Readonly<Record<string, boolean>>,
): string[] {
    return orderColumns([...columns], [...savedOrder]).filter(column => hidden[column] !== true);
}

export function gridColumnLabel(column: string, labels: Readonly<Record<string, string | undefined>>): string {
    return labels[column] === undefined || labels[column] === "" ? column : labels[column]!;
}

function fallbackField(name: string, typeId: number | undefined): GridProjectionField {
    const kind = typeId === 16 ? "boolean" : [20, 21, 23].includes(typeId ?? 0)
        ? "integer"
        : [700, 701, 1700].includes(typeId ?? 0)
        ? "number"
        : typeId === 1082
        ? "date"
        : "text";
    return { name, dataType: kind, kind, isNullable: true, isPrimaryKey: false };
}

function samePhysicalField(left: GridProjectionPhysicalColumn, right: GridProjectionPhysicalColumn): boolean {
    return Boolean(right.field) && right.source.kind === left.source.kind && right.source.id === left.source.id
        && right.source.sqlName === left.source.sqlName && right.source.schemaRevision === left.source.schemaRevision
        && right.physicalColumn === left.physicalColumn;
}

function physicalFieldFor(
    column: string,
    rowTarget: GridProjectionRowTarget,
    physicalColumns: readonly GridProjectionPhysicalColumn[],
): GridProjectionField | undefined {
    const candidates = physicalColumns.filter(candidate =>
        candidate.outputColumn === column
        && (!rowTarget.source || candidate.source.sqlName === rowTarget.source.sourceKind)
    );
    const first = candidates[0];
    return first?.field && candidates.every(candidate => samePhysicalField(first, candidate)) ? first.field : undefined;
}

export function gridFieldFor(
    column: string,
    rowTarget: GridProjectionRowTarget,
    physicalColumns: readonly GridProjectionPhysicalColumn[],
    resultColumns: readonly { readonly name: string; readonly typeId?: number; }[],
): GridProjectionField {
    const field = physicalFieldFor(column, rowTarget, physicalColumns);
    if (field) return field;
    return fallbackField(column, resultColumns.find(candidate => candidate.name === column)?.typeId);
}

/** Canonical, identity-free semantic content for one accepted Grid table result. */
export function projectGridTable(input: GridProjectionInput): GridProjectionResult {
    if (input.context.version !== 1 || input.context.surface !== "table") {
        return { status: "unavailable", reason: "Unsupported Grid observation context" };
    }
    if (!input.context.locale || !input.context.timeZone) {
        return { status: "unavailable", reason: "Grid observation locale and time zone are required" };
    }
    if (input.metadataStatus !== "resolved" && input.metadataStatus !== "relation-free") {
        return { status: "unavailable", reason: "Grid result or schema metadata is incomplete or stale" };
    }
    if (input.rowTargets.length !== input.rows.length || input.rowTargets.some(target => !target.logicalRowId)) {
        return { status: "unavailable", reason: "Grid row-target evidence is incomplete" };
    }
    if (input.metadataStatus === "resolved" && input.physicalColumns.some(candidate => !candidate.field)) {
        return { status: "unavailable", reason: "Grid source schema evidence is incoherent" };
    }
    const columns = gridVisibleColumns(input.columns, input.columnOrder, input.hiddenColumns);
    if (
        columns.some((column) => {
            const metadata = input.resultColumns.find(candidate => candidate.name === column);
            const needsFallback = !isGridCellType(input.componentTypes[column])
                && input.rowTargets.some(target => !physicalFieldFor(column, target, input.physicalColumns));
            return !metadata || (metadata.typeId === undefined && needsFallback);
        })
    ) {
        return { status: "unavailable", reason: "Grid result column metadata is incomplete" };
    }
    // A proven branch may legitimately compute one output, so that occurrence
    // has no physical candidate for that column and uses the result OID just
    // like TableGrid. Refuse only sources absent from the complete accepted
    // provenance, not a known source that lacks a mapping for one output.
    const acceptedSources = new Set(input.physicalColumns.map(candidate => candidate.source.sqlName));
    const incoherentTarget = input.metadataStatus === "resolved"
        && input.rowTargets.some(target => target.source && !acceptedSources.has(target.source.sourceKind));
    if (incoherentTarget) {
        return { status: "unavailable", reason: "Grid row source evidence does not match the accepted result" };
    }
    const projection: GridVisibleProjection = Object.freeze({
        kind: "grid",
        title: input.title,
        columns: Object.freeze(
            columns.map(column => Object.freeze({ label: gridColumnLabel(column, input.columnLabels) })),
        ),
        rows: Object.freeze(input.rows.map((row, rowIndex) => Object.freeze(columns.map(column => {
            const field = gridFieldFor(column, input.rowTargets[rowIndex], input.physicalColumns, input.resultColumns);
            return Object.freeze(
                gridComparableCell(gridDisplayedCell(gridCellType(input.componentTypes[column], field), row[column])),
            );
        })))),
    });
    return { status: "ready", projection };
}
