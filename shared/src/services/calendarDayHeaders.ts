import { utcMsToFloatingDate, utcMsToWallTime } from "../utils/zonedTime.js";
import { addWallDays, wallWeekday } from "./calendarGridRange.js";

export function formatCalendarRangeLabel(start: number, end: number, timeZone: string, locale?: string): string {
    const formatter = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium" });
    return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end - 1))} (${timeZone})`;
}

export interface DayHeader {
    dayIndex: number;
    /** UTC instant of this column's wall-clock midnight in the calendar's zone. */
    dateUtcMs: number;
    /** 0 (Sunday) .. 6 (Saturday), in the calendar's zone. */
    weekday: number;
    /** "2026-08-17" — floating date, already zone-resolved. */
    isoDate: string;
    /** Locale-specific compact weekday and day label. */
    label: string;
    /** Day-of-month for placement and tests. */
    dayOfMonth: number;
    /** First column of a new month, so the header can show the month name once. */
    isMonthStart: boolean;
}

export function computeDayHeaders(
    rangeStart: number,
    dayCount: number,
    timeZone: string,
    locale?: string,
): DayHeader[] {
    const formatter = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric" });
    const headers: DayHeader[] = [];
    let currentUtcMs = rangeStart;
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
        const wallTime = utcMsToWallTime(currentUtcMs, timeZone);
        const isoDate = utcMsToFloatingDate(currentUtcMs, timeZone);
        headers.push({
            dayIndex,
            dateUtcMs: currentUtcMs,
            weekday: wallWeekday(currentUtcMs, timeZone),
            isoDate,
            label: formatter.format(new Date(currentUtcMs)),
            dayOfMonth: wallTime.day,
            isMonthStart: wallTime.day === 1,
        });
        currentUtcMs = addWallDays(currentUtcMs, 1, timeZone);
    }
    return headers;
}
