import type { Project } from "../app-schema.js";
import { type CalendarQueryRows, deriveAcceptedCalendarEntries } from "../services/calendarAcceptedEntries.js";
import { computeDayHeaders, type DayHeader, formatCalendarRangeLabel } from "../services/calendarDayHeaders.js";
import type { CalendarEntryRoles } from "../services/calendarEntries.js";
import {
    DEFAULT_WORKING_HOURS_END_MINUTES,
    DEFAULT_WORKING_HOURS_START_MINUTES,
} from "../services/calendarHourMinuteLayout.js";
import {
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
    readonly workingHoursStartMinutes?: number;
    readonly workingHoursEndMinutes?: number;
}

export interface CalendarDaysVisibleModel {
    readonly layout: TimeGridLayout;
    readonly dayHeaders: DayHeader[];
    readonly workingHoursStartMinutes: number;
    readonly workingHoursEndMinutes: number;
    readonly projection: CalendarVisibleProjection;
}

export type CalendarDaysVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarDaysVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Accepted SQL, committed outline/roles and validated context -> the actual ungrouped Days/Week grid. */
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
    if (input.settings.groupAxes.length > 0) {
        return { ready: false, reason: "Grouped Days/Week projection is not ready." };
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
    const layout = layoutTimeGrid(accepted.entries, context.rangeStartUtcMs, context.rangeEndUtcMs);
    const dayHeaders = computeDayHeaders(context.rangeStartUtcMs, layout.dayCount, context.timeZone, context.locale);
    const workingHoursStartMinutes = input.settings.workingHoursStartMinutes ?? DEFAULT_WORKING_HOURS_START_MINUTES;
    const workingHoursEndMinutes = input.settings.workingHoursEndMinutes ?? DEFAULT_WORKING_HOURS_END_MINUTES;
    const projected = projectCalendarVisibleState(context, {
        title: input.settings.name,
        rangeLabel: formatCalendarRangeLabel(context.rangeStartUtcMs, context.rangeEndUtcMs, context.timeZone,
            context.locale),
        modeLabel: CALENDAR_DAYS_MODE_LABELS[context.viewType],
        labels: [...dayHeaders.map(header => header.label), ...TIME_GRID_HOUR_LABELS],
        content: [
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
            ...dayHeaders.map(header => ({
                kind: "working-hours",
                day: header.dayIndex,
                start: workingHoursStartMinutes,
                end: workingHoursEndMinutes,
            })),
        ],
    });
    if (projected.ready === false) return projected;
    return {
        ready: true,
        model: {
            layout,
            dayHeaders,
            workingHoursStartMinutes,
            workingHoursEndMinutes,
            projection: projected.projection,
        },
    };
}
