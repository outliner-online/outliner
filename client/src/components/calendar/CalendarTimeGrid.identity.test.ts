import { fireEvent, render } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import { buildCalendarEntries, type CalendarEntry } from "../../services/calendar/calendarEntries";
import { layoutTimeGrid } from "../../services/calendar/calendarTimeGridLayout";
import CalendarTimeGrid from "./CalendarTimeGrid.svelte";

const rangeStart = Date.parse("2026-03-10T00:00:00Z");
const rangeEnd = rangeStart + 86_400_000;

function entries(rows: Record<string, unknown>[]) {
    return buildCalendarEntries(
        { columns: ["source_kind", "source_id", "title", "start", "duration"], rows },
        { roleTitle: "title", roleStart: "start", roleDuration: "duration" },
        "UTC",
    );
}

const callbacks = (onKeyboardResize: (entry: CalendarEntry, duration: number) => void) => ({
    rangeStart,
    workingHoursStartMinutes: 9 * 60,
    workingHoursEndMinutes: 17 * 60,
    timeZone: "UTC",
    isStartWritable: () => true,
    isDurationWritable: () => true,
    onDragMove: vi.fn(),
    onDragEnd: vi.fn(),
    onDragCancel: vi.fn(),
    onResizeMove: vi.fn(),
    onResizeEnd: vi.fn(),
    onKeyboardMove: vi.fn(),
    onKeyboardResize,
});

it("keeps the focused logical row through accepted reorder without collapsing duplicate sources", async () => {
    const beta = {
        source_kind: "tasks",
        source_id: "beta",
        title: "Beta",
        start: "2026-03-10T10:00:00Z",
        duration: "00:30:00",
    };
    const alpha = {
        source_kind: "tasks",
        source_id: "alpha",
        title: "Alpha",
        start: "2026-03-10T12:00:00Z",
        duration: "00:30:00",
    };
    const duplicateRows = [
        {
            source_kind: "tasks",
            source_id: "joined",
            title: "Joined one",
            start: "2026-03-10T14:00:00Z",
            duration: "00:30:00",
        },
        {
            source_kind: "tasks",
            source_id: "joined",
            title: "Joined two",
            start: "2026-03-10T15:00:00Z",
            duration: "00:30:00",
        },
    ];
    const resized: { title: string; duration: number; }[] = [];
    const props = callbacks((entry, duration) => resized.push({ title: entry.title, duration }));
    const initial = entries([beta, alpha, ...duplicateRows]);
    const view = render(CalendarTimeGrid, { ...props, layout: layoutTimeGrid(initial, rangeStart, rangeEnd) });
    const betaHandle = view.getByLabelText("Resize Beta") as HTMLElement;
    betaHandle.focus();
    expect(document.activeElement).toBe(betaHandle);

    const reordered = entries([
        {
            source_kind: "tasks",
            source_id: "aaron",
            title: "Aaron",
            start: "2026-03-10T08:00:00Z",
            duration: "00:30:00",
        },
        alpha,
        { ...beta, duration: "00:45:00" },
        ...duplicateRows,
    ]);
    await view.rerender({ ...props, layout: layoutTimeGrid(reordered, rangeStart, rangeEnd) });

    expect(view.getByLabelText("Resize Beta")).toBe(betaHandle);
    expect(document.activeElement).toBe(betaHandle);
    expect(view.getByText("Joined one")).toBeTruthy();
    expect(view.getByText("Joined two")).toBeTruthy();
    await fireEvent.keyDown(betaHandle, { key: "ArrowUp" });
    expect(resized).toEqual([{ title: "Beta", duration: 30 * 60_000 }]);
});
