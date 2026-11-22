import type { Project } from "../app-schema.js";
import { type CalendarQueryRows, deriveAcceptedCalendarEntries } from "../services/calendarAcceptedEntries.js";
import { computeDayHeaders, formatCalendarRangeLabel } from "../services/calendarDayHeaders.js";
import type { CalendarEntryRoles } from "../services/calendarEntries.js";
import { layoutTimeGrid, type TimeGridLayout } from "../services/calendarTimeGridLayout.js";
import {
    type CalendarObservationContextV1,
    type CalendarProjectionResult,
    projectCalendarVisibleState,
    validateCalendarObservationContext,
} from "./calendarProjection.js";

export interface CalendarDaySettings extends CalendarEntryRoles {
    readonly name: string;
    readonly groupAxes: readonly string[];
}

export interface CalendarDayVisibleModel {
    readonly layout: TimeGridLayout;
    readonly dayHeaders: ReturnType<typeof computeDayHeaders>;
    readonly projection: Extract<CalendarProjectionResult, { ready: true; }>["projection"];
}

export interface CalendarDayVisibleModelInput {
    readonly current: boolean;
    readonly result: CalendarQueryRows;
    readonly settings: CalendarDaySettings;
    readonly project?: Project;
    readonly context: CalendarObservationContextV1;
}

export type CalendarDayVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarDayVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Accepted SQL/definition/range evidence -> the model shared by Day rendering and observation. */
export function deriveCalendarDayVisibleModel(input: CalendarDayVisibleModelInput): CalendarDayVisibleModelResult {
    const validated = validateCalendarObservationContext(input.context);
    if (validated.valid === false) return { ready: false, reason: validated.error };
    const context = validated.context;
    if (context.viewType !== "day") {
        return { ready: false, reason: "The bounded production projection currently supports Day mode." };
    }
    if (input.settings.groupAxes.length > 0) {
        return { ready: false, reason: "Grouped Day projection is not ready." };
    }
    const accepted = deriveAcceptedCalendarEntries({
        current: input.current,
        result: input.result,
        settings: input.settings,
        timeZone: context.timeZone,
        range: { startUtcMs: context.rangeStartUtcMs, endUtcMs: context.rangeEndUtcMs },
        project: input.project,
    });
    if (!accepted.ready) return accepted;
    const layout = layoutTimeGrid(accepted.entries, context.rangeStartUtcMs, context.rangeEndUtcMs);
    const dayHeaders = computeDayHeaders(
        context.rangeStartUtcMs,
        layout.dayCount,
        context.timeZone,
        context.locale,
    );
    const content = [
        ...layout.timed.map(value => ({
            kind: "timed",
            title: value.entry.title,
            day: value.dayIndex,
            start: value.startFraction,
            end: value.endFraction,
            column: value.columnIndex,
        })),
        ...layout.allDay.map(value => ({
            kind: "all-day",
            title: value.entry.title,
            day: value.dayIndex,
            span: value.spanDays,
        })),
        ...layout.milestones.map(value => ({ kind: "due", title: value.entry.title, day: value.dayIndex })),
    ];
    const projected = projectCalendarVisibleState(context, {
        title: input.settings.name,
        rangeLabel: formatCalendarRangeLabel(context.rangeStartUtcMs, context.rangeEndUtcMs, context.timeZone,
            context.locale),
        modeLabel: "day",
        labels: dayHeaders.map(value => value.label),
        content,
    });
    if (!projected.ready) return projected;
    return { ready: true, model: { layout, dayHeaders, projection: projected.projection } };
}
