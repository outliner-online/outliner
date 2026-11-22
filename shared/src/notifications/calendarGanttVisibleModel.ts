import type { Project } from "../app-schema.js";
import { type CalendarQueryRows, deriveAcceptedCalendarEntries } from "../services/calendarAcceptedEntries.js";
import { formatCalendarRangeLabel } from "../services/calendarDayHeaders.js";
import { type CalendarEntryRoles, resolveCalendarEntryWritability } from "../services/calendarEntries.js";
import { type GanttLayoutResult, layoutGantt } from "../services/calendarGanttLayout.js";
import {
    GANTT_MODE_LABEL,
    GANTT_SCALE_OPTIONS,
    type GanttRowPresentation,
    presentGanttRow,
} from "../services/calendarGanttPresentation.js";
import { computeGanttTicks, type GanttTick } from "../services/calendarGridRange.js";
import { analyzeDirectSelectProjection } from "../services/directSelectProjection.js";
import {
    type CalendarObservationContextV1,
    type CalendarVisibleProjection,
    projectCalendarVisibleState,
    validateCalendarObservationContext,
} from "./calendarProjection.js";

export interface CalendarGanttSettings extends CalendarEntryRoles {
    readonly name: string;
    readonly query: string;
    readonly groupAxes: readonly string[];
}
export interface CalendarGanttVisibleModel {
    readonly layout: GanttLayoutResult;
    readonly rowPresentations: readonly GanttRowPresentation[];
    readonly ticks: GanttTick[];
    readonly projection: CalendarVisibleProjection;
}
export type CalendarGanttVisibleModelResult =
    | { readonly ready: true; readonly model: CalendarGanttVisibleModel; }
    | { readonly ready: false; readonly reason: string; };

/** Ungrouped production hierarchy and rendered geometry from one accepted revision. */
export function deriveCalendarGanttVisibleModel(input: {
    readonly current: boolean;
    readonly result: CalendarQueryRows;
    readonly settings: CalendarGanttSettings;
    readonly project?: Project;
    readonly context: CalendarObservationContextV1;
    /** Unscoped CalendarView retains the existing numeric tick-label fallback. */
    readonly numericTickLabels?: boolean;
}): CalendarGanttVisibleModelResult {
    const validated = validateCalendarObservationContext(input.context);
    if (validated.valid === false) return { ready: false, reason: validated.error };
    const context = validated.context;
    if (context.viewType !== "gantt") return { ready: false, reason: "Gantt evidence requires Gantt context." };
    if (input.settings.groupAxes.length > 0) {
        return { ready: false, reason: "Grouped Gantt projection is unavailable." };
    }
    const accepted = deriveAcceptedCalendarEntries({
        current: input.current,
        result: input.result,
        settings: input.settings,
        project: input.project,
        timeZone: context.timeZone,
        range: { startUtcMs: context.rangeStartUtcMs, endUtcMs: context.rangeEndUtcMs },
    });
    if (!accepted.ready) return accepted;
    const layout = layoutGantt(accepted.entries, [], new Set(context.collapsedEntryKeys));
    const rows = layout.rows ?? [];
    const rowPresentations = rows.map(row => presentGanttRow(row, context.rangeStartUtcMs, context.rangeEndUtcMs));
    const ticks = computeGanttTicks(context.rangeStartUtcMs, context.rangeEndUtcMs, context.ganttScale!,
        context.timeZone, input.numericTickLabels ? undefined : context.locale);
    const writable = analyzeDirectSelectProjection(input.settings.query);
    const content: Record<string, string | number | boolean | null>[] = [
        { kind: "scale", label: GANTT_SCALE_OPTIONS.find(option => option.value === context.ganttScale)!.label },
        ...ticks.map((tick, order) => ({
            kind: "tick",
            order,
            label: tick.label,
            left: (tick.startUtcMs - context.rangeStartUtcMs) / (context.rangeEndUtcMs - context.rangeStartUtcMs) * 100,
        })),
    ];
    rows.forEach((row, order) => {
        const presentation = rowPresentations[order];
        content.push({
            kind: "row",
            row: order,
            title: row.entry.title,
            depth: row.depth,
            hasChildren: row.hasChildren,
            collapsed: row.collapsed,
        });
        if (row.barStartMs !== undefined) {
            content.push({
                kind: "bar",
                row: order,
                title: row.entry.title,
                left: presentation.barLeftPct,
                width: presentation.barWidthPct,
                rollup: row.isRollup,
                readOnly: !row.isRollup
                    && !resolveCalendarEntryWritability(row.entry, input.settings, writable).startWritable,
            });
        } else if (presentation.startPointPct !== undefined) {
            content.push({
                kind: "point",
                row: order,
                title: `● ${row.entry.title}`,
                left: presentation.startPointPct,
            });
        }
        if (presentation.duePct !== undefined) {
            content.push({ kind: "due", row: order, label: "◆", left: presentation.duePct });
        }
    });
    const projected = projectCalendarVisibleState(context, {
        title: input.settings.name,
        rangeLabel: formatCalendarRangeLabel(context.rangeStartUtcMs, context.rangeEndUtcMs, context.timeZone,
            context.locale),
        modeLabel: GANTT_MODE_LABEL,
        labels: [...GANTT_SCALE_OPTIONS.map(option => option.label), ...ticks.map(tick => tick.label)],
        content,
    });
    if (!projected.ready) return projected;
    return { ready: true, model: { layout, rowPresentations, ticks, projection: projected.projection } };
}
