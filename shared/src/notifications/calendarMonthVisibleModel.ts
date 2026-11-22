import type { Project } from "../app-schema.js";
import { type CalendarQueryRows, deriveAcceptedCalendarEntries } from "../services/calendarAcceptedEntries.js";
import { formatCalendarRangeLabel } from "../services/calendarDayHeaders.js";
import { type CalendarEntryRoles, resolveCalendarEntryWritability } from "../services/calendarEntries.js";
import {
    collapseLanePath,
    entryAxisValues,
    groupCalendarEntries,
    hasCalendarGroupingEvidence,
} from "../services/calendarGrouping.js";
import {
    type CalendarMonthPresentation,
    layoutMonthGrid,
    MONTH_MODE_LABEL,
    type MonthCell,
    monthCellDateLabel,
    monthChipPresentation,
    monthMilestoneLabel,
    monthWeekdayHeaders,
} from "../services/calendarMonthGridLayout.js";
import { analyzeDirectSelectProjection } from "../services/directSelectProjection.js";
import {
    type CalendarObservationContextV1,
    type CalendarVisibleProjection,
    projectCalendarVisibleState,
    validateCalendarObservationContext,
} from "./calendarProjection.js";

export interface CalendarMonthSettings extends CalendarEntryRoles {
    readonly name: string;
    readonly query: string;
    readonly groupAxes: readonly string[];
    readonly laneOrder?: readonly string[];
    readonly showEmptyLanes?: boolean;
}
export interface CalendarMonthVisibleModel {
    readonly cells: MonthCell[];
    readonly presentation: CalendarMonthPresentation;
    readonly laneOptions: readonly string[] | undefined;
    readonly projection: CalendarVisibleProjection;
}
export type CalendarMonthVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarMonthVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Accepted evidence -> the actual first-value Month filter, cells, presentation and comparison. */
export function deriveCalendarMonthVisibleModel(input: {
    readonly current: boolean;
    readonly result: CalendarQueryRows;
    readonly settings: CalendarMonthSettings;
    readonly project?: Project;
    readonly context: CalendarObservationContextV1;
}): CalendarMonthVisibleModelResult {
    const validated = validateCalendarObservationContext(input.context);
    if (validated.valid === false) return { ready: false, reason: validated.error };
    const context = validated.context;
    if (context.viewType !== "month") return { ready: false, reason: "Month evidence requires Month context." };
    const axis = input.settings.groupAxes[0];
    if (axis !== undefined && !hasCalendarGroupingEvidence(input.result, axis)) {
        return { ready: false, reason: "Calendar grouping evidence is unavailable or ambiguous." };
    }
    const accepted = deriveAcceptedCalendarEntries({
        current: input.current,
        result: input.result,
        settings: input.settings,
        project: input.project,
        timeZone: context.timeZone,
        range: { startUtcMs: context.rangeStartUtcMs, endUtcMs: context.rangeEndUtcMs },
    });
    if (accepted.ready === false) return accepted;
    const laneOptions = axis === undefined ? undefined : groupCalendarEntries(accepted.entries, [axis], {
        laneOrder: input.settings.laneOrder,
        showEmptyLanes: input.settings.showEmptyLanes,
        locale: context.locale,
    }).map(lane => collapseLanePath(lane.path));
    if (laneOptions && new Set(laneOptions).size !== laneOptions.length) {
        return { ready: false, reason: "Month lane labels are ambiguous." };
    }
    if (context.monthLaneFilter !== null && !laneOptions?.includes(context.monthLaneFilter)) {
        return { ready: false, reason: "Selected Month lane is unavailable." };
    }
    const laneLabel = (entry: typeof accepted.entries[number]) =>
        axis === undefined
            ? undefined
            : collapseLanePath([entryAxisValues(entry, axis)[0]]);
    const entries = context.monthLaneFilter === null
        ? accepted.entries
        : accepted.entries.filter(entry => laneLabel(entry) === context.monthLaneFilter);
    const cells = layoutMonthGrid(entries, context.rangeStartUtcMs, context.rangeEndUtcMs);
    const writable = analyzeDirectSelectProjection(input.settings.query);
    const presentation: CalendarMonthPresentation = {
        weekdayHeaders: monthWeekdayHeaders(context.weekStart, context.locale),
        cellLabels: cells.map(cell => monthCellDateLabel(cell.dateUtcMs)),
        chips: new Map(
            entries.map(
                entry => [entry.key,
                    monthChipPresentation(laneLabel(entry),
                        resolveCalendarEntryWritability(entry, input.settings, writable).startWritable)],
            ),
        ),
    };
    const projected = projectCalendarVisibleState(context, {
        title: input.settings.name,
        rangeLabel: formatCalendarRangeLabel(context.rangeStartUtcMs, context.rangeEndUtcMs, context.timeZone,
            context.locale),
        modeLabel: MONTH_MODE_LABEL,
        labels: [...(laneOptions ? ["All lanes", ...laneOptions] : []), ...presentation.weekdayHeaders],
        content: [
            ...(laneOptions ? [{ kind: "lane-filter", label: context.monthLaneFilter ?? "All lanes" }] : []),
            ...cells.flatMap(cell => [
                { kind: "cell", cell: cell.dayIndex, label: presentation.cellLabels[cell.dayIndex] },
                ...cell.milestones.map((entry, order) => ({
                    kind: "due",
                    cell: cell.dayIndex,
                    order,
                    title: monthMilestoneLabel(entry.title),
                })),
                ...cell.entries.map(({ entry }, order) => ({
                    kind: "entry",
                    cell: cell.dayIndex,
                    order,
                    title: entry.title,
                    background: presentation.chips.get(entry.key)!.background,
                })),
            ]),
        ],
    });
    if (projected.ready === false) return projected;
    return { ready: true, model: { cells, presentation, laneOptions, projection: projected.projection } };
}
