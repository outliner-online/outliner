import type { CalendarVisibleProjection } from "$shared/notifications/calendarProjection";

/** A row's observed presentation; reused only by independent DOM readers. */
export function ganttRowDom(node: HTMLElement, row: number) {
    const content: Record<string, string | number | boolean | null>[] = [];
    const label = node.querySelector<HTMLElement>(".label-cell")!;
    const collapse = node.querySelector(".collapse-toggle");
    content.push({
        kind: "row",
        row,
        title: label.querySelector(".label-text")!.textContent!.trim(),
        depth: (parseFloat(label.style.paddingLeft) - 8) / 14,
        hasChildren: collapse !== null,
        collapsed: collapse?.textContent!.trim() === "▸",
    });
    const bar = node.querySelector<HTMLElement>(".gantt-bar");
    const point = node.querySelector<HTMLElement>(".start-point");
    const due = node.querySelector<HTMLElement>(".due-marker");
    if (bar) {
        content.push({
            kind: "bar",
            row,
            title: bar.querySelector(".bar-title")!.textContent!.trim(),
            left: parseFloat(bar.style.left),
            width: parseFloat(bar.style.width),
            rollup: bar.classList.contains("rollup"),
            readOnly: bar.classList.contains("not-writable"),
        });
    } else if (point) {
        content.push({ kind: "point", row, title: point.textContent!.trim(), left: parseFloat(point.style.left) });
    }
    if (due) content.push({ kind: "due", row, label: due.textContent!.trim(), left: parseFloat(due.style.left) });
    return content;
}

/** Actual DOM/CSS only: no Calendar geometry, hierarchy, ticks or projection helper. */
export function ganttDom(root: HTMLElement) {
    const scale = root.querySelector<HTMLSelectElement>('[data-testid="calendar-gantt-scale"]')!;
    const ticks = Array.from(root.querySelectorAll<HTMLElement>(".tick-label"));
    const content: Record<string, string | number | boolean | null>[] = [
        { kind: "scale", label: scale.selectedOptions[0].textContent! },
        ...ticks.map((tick, order) => ({
            kind: "tick",
            order,
            label: tick.textContent!.trim(),
            left: parseFloat(tick.style.left),
        })),
    ];
    const groupedHint = root.querySelector('[data-testid="calendar-gantt-grouped-hint"]');
    const lanes = Array.from(root.querySelectorAll<HTMLElement>(".lane-section"));
    if (groupedHint) {
        content.splice(1, 0, { kind: "grouped-hint", label: groupedHint.textContent!.trim() });
        lanes.forEach((section, lane) => {
            content.push({ kind: "lane", lane, label: section.querySelector(".lane-header")!.textContent!.trim() });
            Array.from(section.querySelectorAll<HTMLElement>(".gantt-row")).forEach((node, row) => {
                content.push(...ganttRowDom(node, row).map(value => ({ ...value, lane })));
            });
        });
    } else {
        Array.from(root.querySelectorAll<HTMLElement>(".gantt-row")).forEach((node, row) => {
            content.push(...ganttRowDom(node, row));
        });
    }
    return {
        version: 1,
        title: root.querySelector('[data-testid="calendar-name"]')!.textContent,
        rangeLabel: root.querySelector('[data-testid="calendar-range-label"]')!.textContent,
        modeLabel:
            root.querySelector<HTMLSelectElement>('[data-testid="calendar-view-type"]')!.selectedOptions[0].textContent,
        labels: [...Array.from(scale.options).map(option => option.textContent!),
            ...ticks.map(tick => tick.textContent!.trim()),
            ...lanes.map(lane => lane.querySelector(".lane-header")!.textContent!.trim())],
        content,
    };
}

/** JSDOM's CSSOM serializes numeric percentages to six significant digits. */
export function ganttCssObservation(projection: CalendarVisibleProjection) {
    return {
        ...projection,
        content: projection.content.map(item => {
            const value = { ...item };
            for (const field of ["left", "width"]) {
                if (typeof value[field] === "number") value[field] = Number(value[field].toPrecision(6));
            }
            return value;
        }),
    };
}
