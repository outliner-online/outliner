import type { Project } from "../app-schema.js";
import { type CalendarQueryRows, deriveAcceptedCalendarEntries } from "../services/calendarAcceptedEntries.js";
import { computeDayHeaders, type DayHeader, formatCalendarRangeLabel } from "../services/calendarDayHeaders.js";
import type { CalendarEntryRoles } from "../services/calendarEntries.js";
import { groupCalendarEntries } from "../services/calendarGrouping.js";
import {
    DEFAULT_WORKING_HOURS_END_MINUTES,
    DEFAULT_WORKING_HOURS_START_MINUTES,
} from "../services/calendarHourMinuteLayout.js";
import {
    type CalendarLaneTimeGridBand,
    layoutCalendarLaneTimeGrid,
    layoutTimeGrid,
    TIME_GRID_HOUR_LABELS,
    type TimeGridLayout,
    timeGridMilestoneLabel,
} from "../services/calendarTimeGridLayout.js";
import {
    type CalendarObservationContextV1,
    type CalendarVisibleProjection,
    projectCalendarVisibleState,
    validateCalendarObservationContext,
} from "./calendarProjection.js";

export const CALENDAR_DAYS_MODE_LABELS = { days: "Multi-day", week: "Week" } as const;

export interface CalendarDaysSettings extends CalendarEntryRoles {
    readonly name: string;
    readonly groupAxes: readonly string[];
    readonly laneOrder?: readonly string[];
    readonly showEmptyLanes?: boolean;
    readonly workingHoursStartMinutes?: number;
    readonly workingHoursEndMinutes?: number;
}

export interface CalendarDaysVisibleModel {
    readonly layout: TimeGridLayout | undefined;
    readonly bands: CalendarLaneTimeGridBand[] | undefined;
    readonly dayHeaders: DayHeader[];
    readonly workingHoursStartMinutes: number;
    readonly workingHoursEndMinutes: number;
    readonly projection: CalendarVisibleProjection;
}

export type CalendarDaysVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarDaysVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Accepted SQL, committed outline/roles and validated context -> the actual Days/Week grid and lane bands. */
export function deriveCalendarDaysVisibleModel(input: {
    readonly current: boolean;
    readonly result: CalendarQueryRows;
    readonly settings: CalendarDaysSettings;
    readonly project?: Project;
    readonly context: CalendarObservationContextV1;
}): CalendarDaysVisibleModelResult {
    const validated = validateCalendarObservationContext(input.context);
    if (validated.valid === false) return { ready: false, reason: validated.error };
    const context = validated.context;
    if (context.viewType !== "days" && context.viewType !== "week") {
        return { ready: false, reason: "Days/Week evidence requires Days or Week context." };
    }
    // The production flat lane renderer uses the first configured axis only.
    const groupAxis = input.settings.groupAxes[0];
    if (
        groupAxis !== undefined && (
            input.result.columns.filter(column => column === groupAxis).length !== 1
            || input.result.rows.some(row => !Object.hasOwn(row, groupAxis) || row[groupAxis] === undefined)
        )
    ) {
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
    const layout = groupAxis === undefined
        ? layoutTimeGrid(accepted.entries, context.rangeStartUtcMs, context.rangeEndUtcMs)
        : undefined;
    const bands = groupAxis === undefined ? undefined : layoutCalendarLaneTimeGrid(
        groupCalendarEntries(accepted.entries, [groupAxis], {
            laneOrder: input.settings.laneOrder,
            showEmptyLanes: input.settings.showEmptyLanes,
            locale: context.locale,
        }),
        context.rangeStartUtcMs,
        context.rangeEndUtcMs,
    );
    const dayCount = (layout ?? bands?.[0]?.layout
        ?? layoutTimeGrid([], context.rangeStartUtcMs, context.rangeEndUtcMs)).dayCount;
    const dayHeaders = computeDayHeaders(context.rangeStartUtcMs, dayCount, context.timeZone, context.locale);
    const workingHoursStartMinutes = input.settings.workingHoursStartMinutes ?? DEFAULT_WORKING_HOURS_START_MINUTES;
    const workingHoursEndMinutes = input.settings.workingHoursEndMinutes ?? DEFAULT_WORKING_HOURS_END_MINUTES;
    const projected = projectCalendarVisibleState(context, {
        title: input.settings.name,
        rangeLabel: formatCalendarRangeLabel(context.rangeStartUtcMs, context.rangeEndUtcMs, context.timeZone,
            context.locale),
        modeLabel: CALENDAR_DAYS_MODE_LABELS[context.viewType],
        labels: bands
            ? [
                ...(bands.length > 0 ? dayHeaders.map(header => header.label) : []),
                ...bands.flatMap(band => [band.label, ...TIME_GRID_HOUR_LABELS]),
            ]
            : [...dayHeaders.map(header => header.label), ...TIME_GRID_HOUR_LABELS],
        content: bands
            ? bands.flatMap((band, lane) => [
                { kind: "lane", lane, label: band.label },
                ...timeGridContent(band.layout, workingHoursStartMinutes, workingHoursEndMinutes)
                    .map(value => ({ ...value, lane })),
            ])
            : timeGridContent(layout!, workingHoursStartMinutes, workingHoursEndMinutes),
    });
    if (projected.ready === false) return projected;
    return {
        ready: true,
        model: {
            layout,
            bands,
            dayHeaders,
            workingHoursStartMinutes,
            workingHoursEndMinutes,
            projection: projected.projection,
        },
    };
}

function timeGridContent(
    layout: TimeGridLayout,
    workingHoursStartMinutes: number,
    workingHoursEndMinutes: number,
): CalendarVisibleProjection["content"] {
    return [
        ...layout.timed.map(value => ({
            kind: "timed",
            title: value.entry.title,
            day: value.dayIndex,
            start: value.startFraction,
            end: value.endFraction,
            column: value.columnIndex,
            columns: value.columnCount,
        })),
        ...layout.allDay.map(value => ({
            kind: "all-day",
            title: value.entry.title,
            day: value.dayIndex,
            span: value.spanDays,
        })),
        ...layout.milestones.map(value => ({
            kind: "due",
            title: timeGridMilestoneLabel(value.entry.title),
            day: value.dayIndex,
        })),
        ...Array.from({ length: layout.dayCount }, (_, day) => ({
            kind: "working-hours",
            day,
            start: workingHoursStartMinutes,
            end: workingHoursEndMinutes,
        })),
    ];
}
