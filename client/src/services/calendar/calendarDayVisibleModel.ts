import type { Project } from "$shared/app-schema";
import {
    type CalendarObservationContextV1,
    type CalendarProjectionResult,
    projectCalendarVisibleState,
} from "$shared/notifications/calendarProjection";
import type { TableQueryResult } from "../yjstable/tableSyncAdapter";
import { deriveAcceptedCalendarEntries } from "./calendarAcceptedEntries";
import { computeDayHeaders } from "./calendarDayHeaders";
import type { CalendarSettings } from "./calendarService";
import { layoutTimeGrid, type TimeGridLayout } from "./calendarTimeGridLayout";

export interface CalendarDayVisibleModel {
    readonly layout: TimeGridLayout;
    readonly dayHeaders: ReturnType<typeof computeDayHeaders>;
    readonly projection: Extract<CalendarProjectionResult, { ready: true; }>["projection"];
}

export interface CalendarDayVisibleModelInput {
    readonly current: boolean;
    readonly result: TableQueryResult;
    readonly settings: CalendarSettings;
    readonly project?: Project;
    readonly context: CalendarObservationContextV1;
    readonly title: string;
    readonly rangeLabel: string;
}

export type CalendarDayVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarDayVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Accepted SQL/definition/range evidence -> the model shared by Day rendering and observation. */
export function deriveCalendarDayVisibleModel(input: CalendarDayVisibleModelInput): CalendarDayVisibleModelResult {
    if (input.context.viewType !== "day") {
        return { ready: false, reason: "The bounded production projection currently supports Day mode." };
    }
    const accepted = deriveAcceptedCalendarEntries({
        current: input.current,
        result: input.result,
        settings: input.settings,
        timeZone: input.context.timeZone,
        range: { startUtcMs: input.context.rangeStartUtcMs, endUtcMs: input.context.rangeEndUtcMs },
        project: input.project,
    });
    if (!accepted.ready) return accepted;
    const layout = layoutTimeGrid(accepted.entries, input.context.rangeStartUtcMs, input.context.rangeEndUtcMs);
    const dayHeaders = computeDayHeaders(
        input.context.rangeStartUtcMs,
        layout.dayCount,
        input.context.timeZone,
        input.context.locale,
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
    const projected = projectCalendarVisibleState(input.context, {
        title: input.title,
        rangeLabel: input.rangeLabel,
        modeLabel: "day",
        labels: dayHeaders.map(value => value.label),
        content,
    });
    if (!projected.ready) return projected;
    return { ready: true, model: { layout, dayHeaders, projection: projected.projection } };
}
