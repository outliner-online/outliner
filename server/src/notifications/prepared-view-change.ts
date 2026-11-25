import type { ObservationContext, TargetRef, VisibleProjection } from "./view-observation.js";

export type NotificationChannel = "mcp" | "mobile";

export interface ViewChangeSummary {
    readonly counts: {
        readonly previousItems: number;
        readonly currentItems: number;
        /** Changed visible positions, not an inferred count of source-row mutations. */
        readonly changedItems: number;
        readonly changedLabels: number;
    };
    readonly examples: readonly { readonly text: string; readonly truncated: boolean; }[];
    readonly examplesTruncated: boolean;
}

/** The bounded, externally safe part of one immutable delivery opportunity. */
export interface ViewChangePayload {
    readonly eventId: string;
    readonly ruleId: string;
    readonly channel: NotificationChannel;
    readonly target: TargetRef;
    readonly observedAt: string;
    readonly settingsRevision: number;
    readonly sourceVersionToken: string;
    readonly effectiveContext: ObservationContext;
    readonly deepLink: string;
    readonly summary: ViewChangeSummary;
}

export interface CurrentViewChange extends ViewChangePayload {
    /** Check synchronously after all awaits, immediately before the first write/end. */
    isCurrent(): boolean;
}

export type ViewChangeRevalidation =
    | { readonly status: "current"; readonly candidate: CurrentViewChange; }
    | { readonly status: "cancelled" | "deferred"; readonly reason: string; };

export interface ViewChangeAttemptOutcome {
    /** True only when at least one destination initiated this exact candidate's HTTP body. */
    readonly initiated: boolean;
    readonly outcome:
        | "accepted"
        | "failed"
        | "unknown"
        | "expired"
        | "no_destination"
        | "cancelled"
        | "deferred";
}

export interface PreparedViewChange extends ViewChangePayload {
    /** A different semantic payload is deferred and offered under a separate event ID. */
    revalidate(): Promise<ViewChangeRevalidation>;
    /** Report the aggregate opportunity once; provider acceptance is not delivery evidence. */
    settleAttempt(outcome: ViewChangeAttemptOutcome): void;
}

/** Compare the prerequisite's complete canonical semantic projections, never source data. */
export function visibleProjectionsEqual(before: VisibleProjection, after: VisibleProjection): boolean {
    return JSON.stringify(before) === JSON.stringify(after);
}

interface DisplayedPart {
    readonly comparison: unknown;
    readonly text: () => Iterable<string>;
}

/**
 * Produce bounded examples from known display fields only. Positional counts
 * preserve meaningful order without inventing hidden record identities. Calendar
 * items count projected layout entries, which can include labels and decorations.
 */
export function summarizeViewChange(before: VisibleProjection, after: VisibleProjection): ViewChangeSummary {
    const examples: { readonly text: string; readonly truncated: boolean; }[] = [];
    let exampleCount = 0;
    const collect = (prior: DisplayedPart | undefined, next: DisplayedPart | undefined) => {
        exampleCount++;
        if (examples.length >= 3) return;
        const prefix = prior === undefined ? "Added: " : next === undefined ? "Removed: " : "Changed: ";
        examples.push(boundedExample(prefix, (next ?? prior)!.text()));
    };
    const changedLabels = compareParts(labels(before), labels(after), collect);
    let previousItems = 0;
    let currentItems = 0;
    function* counted(projection: VisibleProjection, prior: boolean): Generator<DisplayedPart> {
        for (const part of items(projection)) {
            if (prior) previousItems++;
            else currentItems++;
            yield part;
        }
    }
    const changedItems = compareParts(counted(before, true), counted(after, false), collect);
    return Object.freeze({
        counts: Object.freeze({ previousItems, currentItems, changedItems, changedLabels }),
        examples: Object.freeze(examples),
        examplesTruncated: exampleCount > examples.length,
    });
}

function compareParts(
    before: Iterable<DisplayedPart>,
    after: Iterable<DisplayedPart>,
    changed: (before: DisplayedPart | undefined, after: DisplayedPart | undefined) => void,
): number {
    const prior = before[Symbol.iterator]();
    const next = after[Symbol.iterator]();
    let count = 0;
    for (;;) {
        const left = prior.next();
        const right = next.next();
        if (left.done && right.done) return count;
        if (JSON.stringify(left.value?.comparison) !== JSON.stringify(right.value?.comparison)) {
            count++;
            changed(left.value, right.value);
        }
    }
}

function textPart(value: string): DisplayedPart {
    return { comparison: value, text: () => [value] };
}

function* labels(projection: VisibleProjection): Generator<DisplayedPart> {
    yield textPart(projection.title);
    if ("kind" in projection && projection.kind === "grid") {
        for (const column of projection.columns) yield textPart(column.label);
    } else if ("kind" in projection && projection.kind === "kanban") {
        for (const lane of projection.lanes) {
            yield textPart(lane.label);
            yield textPart(lane.kindLabel);
        }
    } else if ("content" in projection) {
        yield textPart(projection.rangeLabel);
        yield textPart(projection.modeLabel);
        for (const label of projection.labels) yield textPart(label);
    }
}

function* items(projection: VisibleProjection): Generator<DisplayedPart> {
    if ("kind" in projection && projection.kind === "grid") {
        for (const row of projection.rows) {
            yield {
                comparison: row,
                text: function*() {
                    for (let index = 0; index < row.length; index++) {
                        if (index > 0) yield "; ";
                        const column = projection.columns[index];
                        if (column) {
                            yield column.label;
                            yield ": ";
                        }
                        const cell = row[index]!;
                        yield "value" in cell ? cell.value : cell.checked ? "☑" : "☐";
                    }
                },
            };
        }
    } else if ("kind" in projection && projection.kind === "kanban") {
        for (let laneIndex = 0; laneIndex < projection.lanes.length; laneIndex++) {
            const lane = projection.lanes[laneIndex]!;
            for (const card of lane.cards) {
                yield {
                    comparison: [laneIndex, card],
                    text: function*() {
                        yield lane.label;
                        yield ": ";
                        yield card.title;
                        for (const detail of card.details) {
                            yield "; ";
                            yield detail.label;
                            yield ": ";
                            yield detail.value;
                        }
                    },
                };
            }
        }
    } else if ("content" in projection) {
        for (const entry of projection.content) {
            yield {
                comparison: entry,
                text: function*() {
                    // Layout coordinates affect equality, but examples contain
                    // only the labels actually presented to the user.
                    const title = typeof entry.title === "string" ? entry.title : undefined;
                    const label = typeof entry.label === "string" ? entry.label : undefined;
                    if (title) yield title;
                    if (label && label !== title) {
                        if (title) yield "; ";
                        yield label;
                    }
                    if (!title && !label) yield "Calendar layout";
                },
            };
        }
    }
}

function boundedExample(
    prefix: string,
    parts: Iterable<string>,
): { readonly text: string; readonly truncated: boolean; } {
    const codePoints: string[] = [];
    function* allParts() {
        yield prefix;
        yield* parts;
    }
    for (const part of allParts()) {
        for (const character of part) {
            if (codePoints.length === 120) {
                codePoints[119] = "…";
                return Object.freeze({ text: codePoints.join(""), truncated: true });
            }
            codePoints.push(character);
        }
    }
    return Object.freeze({ text: codePoints.join(""), truncated: false });
}
