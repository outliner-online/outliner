import type { Project } from "../app-schema.js";
import { type CalendarQueryRows, deriveAcceptedCalendarEntries } from "../services/calendarAcceptedEntries.js";
import { computeDayHeaders, type DayHeader, formatCalendarRangeLabel } from "../services/calendarDayHeaders.js";
import type { CalendarEntryRoles } from "../services/calendarEntries.js";
import {
    DEFAULT_WORKING_HOURS_END_MINUTES,
    DEFAULT_WORKING_HOURS_START_MINUTES,
    HOUR_MAP_MINUTE_TICKS,
    HOUR_MAP_MODE_LABEL,
    type HourMinuteLayout,
    hourMinuteTickLabel,
    hourRowLabel,
    layoutHourMinuteGrid,
} from "../services/calendarHourMinuteLayout.js";
import {
    type CalendarObservationContextV1,
    type CalendarVisibleProjection,
    projectCalendarVisibleState,
    validateCalendarObservationContext,
} from "./calendarProjection.js";

export interface CalendarHoursSettings extends CalendarEntryRoles {
    readonly name: string;
    readonly workingHoursStartMinutes?: number;
    readonly workingHoursEndMinutes?: number;
}

export interface CalendarHoursVisibleModel {
    readonly layout: HourMinuteLayout;
    readonly dayHeader: DayHeader;
    readonly projection: CalendarVisibleProjection;
}

export type CalendarHoursVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarHoursVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Current accepted SQL + committed roles/outline evidence -> the production Hours layout and observation. */
export function deriveCalendarHoursVisibleModel(input: {
    readonly current: boolean;
    readonly result: CalendarQueryRows;
    readonly settings: CalendarHoursSettings;
    readonly context: CalendarObservationContextV1;
    readonly project?: Project;
}): CalendarHoursVisibleModelResult {
    const validated = validateCalendarObservationContext(input.context);
    if (validated.valid === false) return { ready: false, reason: validated.error };
    const context = validated.context;
    if (context.viewType !== "hours") return { ready: false, reason: "Hours evidence requires Hours context." };
    const accepted = deriveAcceptedCalendarEntries({
        current: input.current,
        result: input.result,
        settings: input.settings,
        timeZone: context.timeZone,
        range: { startUtcMs: context.rangeStartUtcMs, endUtcMs: context.rangeEndUtcMs },
        project: input.project,
    });
    if (accepted.ready === false) return accepted;
    const layout = layoutHourMinuteGrid(accepted.entries, context.rangeStartUtcMs, context.rangeEndUtcMs,
        context.timeZone, {
        workingHoursStartMinutes: input.settings.workingHoursStartMinutes ?? DEFAULT_WORKING_HOURS_START_MINUTES,
        workingHoursEndMinutes: input.settings.workingHoursEndMinutes ?? DEFAULT_WORKING_HOURS_END_MINUTES,
    });
    const dayHeader = computeDayHeaders(context.rangeStartUtcMs, 1, context.timeZone, context.locale)[0];
    const projected = projectCalendarVisibleState(context, {
        title: input.settings.name,
        rangeLabel: formatCalendarRangeLabel(context.rangeStartUtcMs, context.rangeEndUtcMs, context.timeZone,
            context.locale),
        modeLabel: HOUR_MAP_MODE_LABEL,
        labels: [dayHeader.label, ...HOUR_MAP_MINUTE_TICKS.map(hourMinuteTickLabel), ...layout.rows.map(hourRowLabel)],
        content: [
            ...layout.allDay.map(entry => ({ kind: "all-day", title: entry.title })),
            ...layout.milestones.map(entry => ({ kind: "due", title: entry.title })),
            ...layout.rows.flatMap(row => [
                {
                    kind: "hour-row",
                    row: row.rowIndex,
                    label: hourRowLabel(row),
                    lanes: row.laneCount,
                    workingStart: row.workingStartMinute ?? null,
                    workingEnd: row.workingEndMinute ?? null,
                },
                ...row.fragments.map(fragment => ({
                    kind: "fragment",
                    row: row.rowIndex,
                    start: fragment.startMinute,
                    end: fragment.endMinute,
                    lane: fragment.laneIndex,
                    lanes: fragment.laneCount,
                    title: fragment.showTitle ? fragment.entry.title : "",
                    label: fragment.isTitleAnchor ? fragment.entry.title : `${fragment.entry.title} (continued)`,
                    first: fragment.isFirst,
                    last: fragment.isLast,
                })),
            ]),
        ],
    });
    if (projected.ready === false) return projected;
    return { ready: true, model: { layout, dayHeader, projection: projected.projection } };
}
