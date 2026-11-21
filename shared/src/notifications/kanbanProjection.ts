import type { KanbanLaneValue, KanbanSettings } from "../services/kanbanDefinition.js";

export interface KanbanObservationContextV1 {
    version: 1;
    surface: "board";
    locale: string;
    timeZone: string;
}

export interface KanbanVisibleCard {
    readonly title: string;
    readonly details: readonly { readonly label: string; readonly value: string; }[];
}

export interface KanbanVisibleLane {
    readonly label: string;
    readonly kindLabel: string;
    readonly cards: readonly KanbanVisibleCard[];
}

export interface KanbanVisibleProjection {
    readonly kind: "kanban";
    readonly title: string;
    readonly lanes: readonly KanbanVisibleLane[];
}

export type KanbanVisibleProjectionResult =
    | { readonly status: "ready"; readonly content: KanbanVisibleProjection; }
    | { readonly status: "non-ready"; readonly reason: string; };

export interface KanbanRenderLane {
    readonly key: KanbanLaneValue;
    readonly label: string;
    readonly kindLabel: string;
    /** Indexes in the supplied SQL row sequence. Duplicates are intentional. */
    readonly rowIndexes: readonly number[];
    readonly cards: readonly KanbanVisibleCard[];
}

export interface KanbanRenderModel {
    readonly title: string;
    readonly lanes: readonly KanbanRenderLane[];
}

export interface KanbanRenderInput {
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly settings: Pick<KanbanSettings, "name" | "groupField" | "titleField" | "detailFields" | "laneOrder">;
    readonly declaredGroupingChoices: readonly KanbanLaneValue[];
}

export interface KanbanProjectionInput extends KanbanRenderInput {
    /** Ordered result-column names from the accepted query evidence; duplicates are preserved. */
    readonly columns: readonly string[];
    /** Authoritative query boundary: only an accepted complete/current result is comparable. */
    readonly readiness:
        | { readonly status: "ready"; readonly complete: true; readonly current: true; }
        | { readonly status: "non-ready"; readonly reason: string; };
}

export type KanbanObservationContextParseResult =
    | { readonly status: "absent"; }
    | { readonly status: "valid"; readonly context: KanbanObservationContextV1; }
    | { readonly status: "invalid"; readonly reason: string; };

export function kanbanDisplayedValue(value: unknown): string {
    return value === null ? "NULL" : value === undefined ? "" : String(value);
}

export function kanbanLaneLabel(value: KanbanLaneValue): string {
    if (value === null) return "SQL NULL";
    if (value === "") return "Empty string";
    if (/^\s+$/.test(value)) return `Whitespace (${value.length})`;
    return value;
}

export function kanbanLaneKindLabel(value: KanbanLaneValue): string {
    if (value === null) return "SQL NULL value";
    if (value === "") return "Empty string value";
    return "Text value";
}

/** The one production derivation used both by the interactive board and canonical projection. */
export function deriveKanbanRenderModel(input: KanbanRenderInput): KanbanRenderModel {
    const groupField = input.settings.groupField;
    if (!groupField) throw new Error("Kanban grouping column is required");
    const indexes = new Map<KanbanLaneValue, number[]>();
    const encountered: KanbanLaneValue[] = [];
    input.rows.forEach((row, index) => {
        const value = row[groupField];
        if (value !== null && typeof value !== "string") {
            throw new Error("Grouping values must be strings or SQL NULL");
        }
        const key = value as KanbanLaneValue;
        if (!indexes.has(key)) {
            indexes.set(key, []);
            encountered.push(key);
        }
        indexes.get(key)!.push(index);
    });
    const declared = unique(input.declaredGroupingChoices);
    const eligible = [...declared, ...encountered.filter(key => !declared.includes(key))];
    const preferred = unique(input.settings.laneOrder).filter(key => eligible.includes(key));
    const order = [...preferred, ...eligible.filter(key => !preferred.includes(key))];
    const lanes = order.map(key => {
        const rowIndexes = indexes.get(key) ?? [];
        return Object.freeze({
            key,
            label: kanbanLaneLabel(key),
            kindLabel: kanbanLaneKindLabel(key),
            rowIndexes: Object.freeze([...rowIndexes]),
            cards: Object.freeze(rowIndexes.map(index => visibleCard(input.rows[index]!, input.settings))),
        });
    });
    return Object.freeze({ title: input.settings.name, lanes: Object.freeze(lanes) });
}

export function createKanbanVisibleProjection(
    input: KanbanProjectionInput,
    context: KanbanObservationContextV1,
): KanbanVisibleProjectionResult {
    if (input.readiness.status !== "ready" || !input.readiness.complete || !input.readiness.current) {
        return nonReadyKanbanProjection(
            input.readiness.status === "non-ready" ? input.readiness.reason : "Kanban query result is not ready",
        );
    }
    if (!isKanbanObservationContextV1(context)) {
        return Object.freeze({ status: "non-ready", reason: "Unsupported Kanban observation context" });
    }
    try {
        validateConfiguredColumns(input.columns, input.settings);
        const model = deriveKanbanRenderModel(input);
        return Object.freeze({
            status: "ready",
            content: Object.freeze({
                kind: "kanban",
                title: model.title,
                lanes: Object.freeze(model.lanes.map(lane => Object.freeze({
                    label: lane.label,
                    kindLabel: lane.kindLabel,
                    cards: lane.cards,
                }))),
            }),
        });
    } catch (error) {
        return Object.freeze({
            status: "non-ready",
            reason: error instanceof Error ? error.message : "Kanban projection is unavailable",
        });
    }
}

function validateConfiguredColumns(
    columns: readonly string[],
    settings: KanbanRenderInput["settings"],
): void {
    const groupMatches = columns.filter(column => column === settings.groupField).length;
    if (groupMatches !== 1) {
        throw new Error(groupMatches
            ? `Grouping result column "${settings.groupField}" is duplicated`
            : `Grouping result column "${settings.groupField}" is missing`);
    }
    for (const field of [settings.titleField, ...settings.detailFields].filter((value): value is string => !!value)) {
        const matches = columns.filter(column => column === field).length;
        if (matches !== 1) {
            throw new Error(matches
                ? `Configured result column "${field}" is duplicated`
                : `Configured result column "${field}" is missing`);
        }
    }
}

export function nonReadyKanbanProjection(reason: string): KanbanVisibleProjectionResult {
    return Object.freeze({ status: "non-ready", reason });
}

export function isKanbanObservationContextV1(value: unknown): value is KanbanObservationContextV1 {
    if (!value || typeof value !== "object") return false;
    const context = value as Partial<KanbanObservationContextV1>;
    return context.version === 1 && context.surface === "board"
        && typeof context.locale === "string" && validLocale(context.locale)
        && typeof context.timeZone === "string" && validTimeZone(context.timeZone);
}

/** Shared route/producer parser so malformed explicit contexts can never fall back to an ordinary board. */
export function parseKanbanObservationContext(parameters: URLSearchParams): KanbanObservationContextParseResult {
    const keys = ["surface", "version", "locale", "timeZone"];
    if (!keys.some(key => parameters.has(key))) return Object.freeze({ status: "absent" });
    const candidate = {
        surface: parameters.get("surface"),
        version: Number(parameters.get("version")),
        locale: parameters.get("locale"),
        timeZone: parameters.get("timeZone"),
    };
    if (!isKanbanObservationContextV1(candidate)) {
        return Object.freeze({ status: "invalid", reason: "Unsupported Kanban observation context." });
    }
    return Object.freeze({ status: "valid", context: Object.freeze(candidate) });
}

function visibleCard(
    row: Readonly<Record<string, unknown>>,
    settings: KanbanRenderInput["settings"],
): KanbanVisibleCard {
    const displayedTitle = settings.titleField ? kanbanDisplayedValue(row[settings.titleField]) : "";
    return Object.freeze({
        title: displayedTitle || "Untitled",
        details: Object.freeze(settings.detailFields.map((label: string) => Object.freeze({
            label,
            value: kanbanDisplayedValue(row[label]),
        }))),
    });
}

function validLocale(locale: string): boolean {
    try {
        return Intl.getCanonicalLocales(locale).length === 1;
    } catch {
        return false;
    }
}

function validTimeZone(timeZone: string): boolean {
    try {
        return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone.length > 0;
    } catch {
        return false;
    }
}

function unique(values: readonly KanbanLaneValue[]): KanbanLaneValue[] {
    return [...new Set(values)];
}
