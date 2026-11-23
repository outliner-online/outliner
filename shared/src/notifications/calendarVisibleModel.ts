import type { Project } from "../app-schema.js";
import type { CalendarQueryRows } from "../services/calendarAcceptedEntries.js";
import {
    type CalendarDaysSettings,
    type CalendarDaysVisibleModel,
    deriveCalendarDaysVisibleModel,
} from "./calendarDaysVisibleModel.js";
import { type CalendarDayVisibleModel, deriveCalendarDayVisibleModel } from "./calendarDayVisibleModel.js";
import { type CalendarGanttVisibleModel, deriveCalendarGanttVisibleModel } from "./calendarGanttVisibleModel.js";
import { type CalendarHoursVisibleModel, deriveCalendarHoursVisibleModel } from "./calendarHoursVisibleModel.js";
import {
    type CalendarMonthSettings,
    type CalendarMonthVisibleModel,
    deriveCalendarMonthVisibleModel,
} from "./calendarMonthVisibleModel.js";
import { type CalendarObservationContextV1, validateCalendarObservationContext } from "./calendarProjection.js";

export interface CalendarVisibleSettings extends CalendarDaysSettings, CalendarMonthSettings {}

/** Trusted caller supplies authorized current query evidence and committed outline/definition, never visible text. */
export interface CalendarVisibleModelInput {
    readonly authority?: {
        readonly current: boolean;
        readonly result?: CalendarQueryRows;
        readonly project?: Project;
    };
    readonly settings: CalendarVisibleSettings;
    readonly context: CalendarObservationContextV1;
    /** Preserve unscoped native Gantt's existing numeric tick labels. */
    readonly numericGanttTickLabels?: boolean;
}
interface Models {
    day: CalendarDayVisibleModel;
    days: CalendarDaysVisibleModel;
    hours: CalendarHoursVisibleModel;
    month: CalendarMonthVisibleModel;
    gantt: CalendarGanttVisibleModel;
}
type NotReady = { readonly ready: false; readonly reason: string; };
type Ready<K extends keyof Models> = {
    readonly ready: true;
    readonly kind: K;
    readonly model: Models[K];
};
export type CalendarVisibleModelResult = NotReady | { [K in keyof Models]: Ready<K>; }[keyof Models];

/** Browser-free comparable state excludes transient today decoration. Authorization/query acquisition remains the caller's responsibility. */
export function deriveCalendarVisibleModel(input: CalendarVisibleModelInput): CalendarVisibleModelResult {
    const validated = validateCalendarObservationContext(input.context);
    if (validated.valid === false) return { ready: false, reason: validated.error };
    const authority = input.authority;
    if (!authority?.current || !authority.result) {
        return { ready: false, reason: "Accepted Calendar SQL evidence is stale or unavailable." };
    }
    const context = validated.context;
    const evidence = {
        current: true,
        result: authority.result,
        project: authority.project,
        settings: input.settings,
        context,
    };
    switch (context.viewType) {
        case "day":
            return input.settings.groupAxes.length > 0
                ? modeResult("days", deriveCalendarDaysVisibleModel(evidence))
                : modeResult("day", deriveCalendarDayVisibleModel(evidence));
        case "days":
        case "week":
            return modeResult("days", deriveCalendarDaysVisibleModel(evidence));
        case "hours":
            return modeResult("hours", deriveCalendarHoursVisibleModel(evidence));
        case "month":
            return modeResult("month", deriveCalendarMonthVisibleModel(evidence));
        case "gantt":
            return modeResult("gantt",
                deriveCalendarGanttVisibleModel({ ...evidence, numericTickLabels: input.numericGanttTickLabels }));
    }
}

function modeResult<K extends keyof Models>(
    kind: K,
    derived: NotReady | { readonly ready: true; readonly model: Models[K]; },
): NotReady | Ready<K> {
    return derived.ready ? { ready: true, kind, model: derived.model } : derived;
}
