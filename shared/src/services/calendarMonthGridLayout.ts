// Pure geometry for the month view (#4347): which day cell each entry
// belongs to. An all-day entry is placed once per day it covers, clipped to
// the visible (already week-padded, see calendarGridRange.ts) grid — "an
// all-day entry occupies exactly one cell per day of its duration" (§6.1) —
// rather than as a single spanning bar, keeping month-view geometry as
// simple per-cell membership a Svelte `{#each}` can render directly.

import type { CalendarEntry } from "./calendarEntries.js";
import { laneColor } from "./calendarLaneColor.js";

const DAY_MS = 86_400_000;

export const MONTH_MODE_LABEL = "Month";

export interface MonthChipPresentation {
    readonly laneLabel: string | undefined;
    readonly background: string;
}

export interface CalendarMonthPresentation {
    readonly weekdayHeaders: readonly string[];
    readonly cellLabels: readonly string[];
    /** Concrete cell/entry positions; a source key may occur in several SQL rows. */
    readonly chipsByCell: readonly (readonly MonthChipPresentation[])[];
}

export function monthWeekdayHeaders(weekStart: number, locale?: string): string[] {
    return Array.from({ length: 7 }, (_, i) => {
        const sundayUtcMs = Date.UTC(2026, 0, 4 + ((weekStart + i) % 7));
        return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(sundayUtcMs));
    });
}

/** Preserve the actual renderer's existing day-number formatting. */
export function monthCellDateLabel(dateUtcMs: number): string {
    return String(new Date(dateUtcMs).getUTCDate());
}

export function monthMilestoneLabel(title: string): string {
    return `◆ ${title}`;
}

export function monthChipPresentation(laneLabel: string | undefined, startWritable: boolean): MonthChipPresentation {
    return {
        laneLabel,
        background: !startWritable ? "#9ca3af" : laneLabel === undefined ? "#2563eb" : laneColor(laneLabel),
    };
}

export interface MonthCellEntry {
    entry: CalendarEntry;
    /** How many grid days this entry's occurrence spans in total (for a leading/trailing "continues" indicator). */
    spanDays: number;
}

export interface MonthCell {
    dayIndex: number;
    /** Local midnight of this cell, as a UTC instant (from the grid's own range). */
    dateUtcMs: number;
    entries: MonthCellEntry[];
    milestones: CalendarEntry[];
}

export function layoutMonthGrid(entries: CalendarEntry[], rangeStart: number, rangeEnd: number): MonthCell[] {
    const dayCount = Math.round((rangeEnd - rangeStart) / DAY_MS);
    const cells: MonthCell[] = Array.from({ length: dayCount }, (_, i) => ({
        dayIndex: i,
        dateUtcMs: rangeStart + i * DAY_MS,
        entries: [],
        milestones: [],
    }));

    for (const entry of entries) {
        if (entry.startMs === undefined) {
            if (entry.dueMs !== undefined && entry.dueMs >= rangeStart && entry.dueMs < rangeEnd) {
                cells[Math.floor((entry.dueMs - rangeStart) / DAY_MS)].milestones.push(entry);
            }
            continue;
        }

        const start = entry.startMs;
        const duration = Math.max(entry.durationMs ?? (entry.allDay ? DAY_MS : 0), entry.allDay ? DAY_MS : 0);
        const end = start + duration;
        if (!(start < rangeEnd && end > rangeStart)) continue;

        if (entry.allDay) {
            const firstIndex = Math.max(0, Math.floor((start - rangeStart) / DAY_MS));
            const lastIndex = Math.min(dayCount - 1, Math.ceil((Math.min(end, rangeEnd) - rangeStart) / DAY_MS) - 1);
            const spanDays = lastIndex - firstIndex + 1;
            for (let i = firstIndex; i <= lastIndex; i++) cells[i].entries.push({ entry, spanDays });
        } else {
            const index = Math.floor((start - rangeStart) / DAY_MS);
            if (index >= 0 && index < dayCount) cells[index].entries.push({ entry, spanDays: 1 });
        }
    }

    return cells;
}
