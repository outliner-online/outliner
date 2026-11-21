import type { KanbanLaneValue, KanbanSettings } from "../services/kanbanDefinition";

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
    input: KanbanRenderInput,
    context: KanbanObservationContextV1,
): KanbanVisibleProjectionResult {
    if (!isKanbanObservationContextV1(context)) {
        return Object.freeze({ status: "non-ready", reason: "Unsupported Kanban observation context" });
    }
    try {
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

export function nonReadyKanbanProjection(reason: string): KanbanVisibleProjectionResult {
    return Object.freeze({ status: "non-ready", reason });
}

export function isKanbanObservationContextV1(value: unknown): value is KanbanObservationContextV1 {
    if (!value || typeof value !== "object") return false;
    const context = value as Partial<KanbanObservationContextV1>;
    return context.version === 1 && context.surface === "board"
        && typeof context.locale === "string" && context.locale.length > 0
        && typeof context.timeZone === "string" && context.timeZone.length > 0;
}

function visibleCard(
    row: Readonly<Record<string, unknown>>,
    settings: KanbanRenderInput["settings"],
): KanbanVisibleCard {
    const displayedTitle = settings.titleField ? kanbanDisplayedValue(row[settings.titleField]) : "";
    return Object.freeze({
        title: displayedTitle || "Untitled",
        details: Object.freeze(settings.detailFields.map(label => Object.freeze({
            label,
            value: kanbanDisplayedValue(row[label]),
        }))),
    });
}

function unique(values: readonly KanbanLaneValue[]): KanbanLaneValue[] {
    return [...new Set(values)];
}
