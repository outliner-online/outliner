import { ganttInstantFraction, type GanttRow, placeGanttBar } from "./calendarGanttLayout.js";

export const GANTT_GROUPED_HINT = "Grouped by axis — hierarchy and roll-up are flattened while a group axis is active.";
export const GANTT_MODE_LABEL = "Gantt";
export const GANTT_SCALE_OPTIONS = [
    { value: "day", label: "Day" },
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
    { value: "quarter", label: "Quarter" },
] as const;

export interface GanttRowPresentation {
    readonly labelPaddingPx: number;
    readonly barInRange: boolean;
    readonly barStartFraction: number;
    readonly barLeftPct: number;
    readonly barWidthPct: number;
    readonly startPointPct: number | undefined;
    readonly duePct: number | undefined;
}

/** Existing rendered geometry, including zero-width off-window bars and the 0.5% minimum. */
export function presentGanttRow(row: GanttRow, rangeStart: number, rangeEnd: number): GanttRowPresentation {
    const bar = placeGanttBar(row, rangeStart, rangeEnd);
    const point = (value: number | undefined) => {
        if (value === undefined) return undefined;
        const fraction = ganttInstantFraction(value, rangeStart, rangeEnd);
        return fraction === undefined ? undefined : fraction * 100;
    };
    return {
        labelPaddingPx: 8 + row.depth * 14,
        barInRange: bar !== undefined,
        barStartFraction: bar?.startFraction ?? 0,
        barLeftPct: bar ? Math.max(0, bar.startFraction * 100) : 0,
        barWidthPct: bar ? Math.max(0.5, (bar.endFraction - bar.startFraction) * 100) : 0,
        startPointPct: row.barStartMs === undefined ? point(row.startPointMs) : undefined,
        duePct: point(row.dueMarkerMs),
    };
}
