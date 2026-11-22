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

const callbacks = (
    onKeyboardResize: (entry: CalendarEntry, duration: number) => void,
    onKeyboardMove: (entry: CalendarEntry, startMs: number) => void = vi.fn(),
) => ({
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
    onKeyboardMove,
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

it("keeps a focused singleton occurrence when a second row for its source arrives", async () => {
    const original = {
        source_kind: "tasks",
        source_id: "shared",
        title: "Original",
        start: "2026-03-10T09:00:00Z",
        duration: "00:30:00",
    };
    const resized: CalendarEntry[] = [];
    const props = callbacks(entry => resized.push(entry));
    const view = render(CalendarTimeGrid, {
        ...props,
        layout: layoutTimeGrid(entries([original]), rangeStart, rangeEnd),
    });
    const handle = view.getByLabelText("Resize Original") as HTMLElement;
    handle.focus();

    await view.rerender({
        ...props,
        layout: layoutTimeGrid(entries([
            original,
            { ...original, title: "Second", start: "2026-03-10T11:00:00Z" },
        ]), rangeStart, rangeEnd),
    });

    expect(view.getByLabelText("Resize Original")).toBe(handle);
    expect(document.activeElement).toBe(handle);
    await fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(resized.map(entry => [entry.title, entry.startMs])).toEqual([["Original", Date.parse(original.start)]]);
});

it("keeps focus on the same distinguishable occurrence when identical titles reorder", async () => {
    const atNine = {
        source_kind: "tasks",
        source_id: "shared",
        title: "Shared",
        start: "2026-03-10T09:00:00Z",
        duration: "00:30:00",
    };
    const atEleven = { ...atNine, start: "2026-03-10T11:00:00Z" };
    const resized: CalendarEntry[] = [];
    const props = callbacks(entry => resized.push(entry));
    const view = render(CalendarTimeGrid, {
        ...props,
        layout: layoutTimeGrid(entries([atNine, atEleven]), rangeStart, rangeEnd),
    });
    const handles = view.getAllByLabelText("Resize Shared") as HTMLElement[];
    const nineHandle = handles.find(handle => handle.parentElement?.getAttribute("style")?.includes("432px"))!;
    nineHandle.focus();

    await view.rerender({
        ...props,
        layout: layoutTimeGrid(entries([atEleven, atNine]), rangeStart, rangeEnd),
    });

    expect(document.activeElement).toBe(nineHandle);
    expect(nineHandle.parentElement?.getAttribute("style")).toContain("432px");
    await fireEvent.keyDown(nineHandle, { key: "ArrowDown" });
    expect(resized.map(entry => entry.startMs)).toEqual([Date.parse(atNine.start)]);
});

it("keeps the focused occurrence through accepted keyboard moves that change its start", async () => {
    const original = {
        source_kind: "tasks",
        source_id: "moving",
        title: "Moving",
        start: "2026-03-10T09:00:00Z",
        duration: "00:30:00",
    };
    const moves: number[] = [];
    let view: ReturnType<typeof render>;
    const onKeyboardMove = async (_entry: CalendarEntry, startMs: number) => {
        moves.push(startMs);
        await view.rerender({
            ...props,
            layout: layoutTimeGrid(entries([{ ...original, start: new Date(startMs).toISOString() }]), rangeStart,
                rangeEnd),
        });
    };
    const props = callbacks(vi.fn(), onKeyboardMove);
    view = render(CalendarTimeGrid, {
        ...props,
        layout: layoutTimeGrid(entries([original]), rangeStart, rangeEnd),
    });
    const title = view.getByText("Moving") as HTMLElement;
    title.focus();

    await fireEvent.keyDown(title, { key: "ArrowDown" });
    expect(document.activeElement).toBe(title);
    expect(title.parentElement?.getAttribute("style")).toContain("444px");
    await fireEvent.keyDown(title, { key: "ArrowUp" });

    expect(document.activeElement).toBe(title);
    expect(title.parentElement?.getAttribute("style")).toContain("432px");
    expect(moves).toEqual([
        Date.parse("2026-03-10T09:15:00Z"),
        Date.parse("2026-03-10T09:00:00Z"),
    ]);
});
