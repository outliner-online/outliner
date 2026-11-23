import { deriveCalendarVisibleModel } from "$shared/notifications/calendarVisibleModel";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getCalendar } from "../../services/calendar/calendarService";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { ganttCssObservation, ganttDom } from "../../tests/fixtures/calendarGanttDom";
import { editHiddenGanttTitleAndRead } from "../../tests/fixtures/calendarGanttHiddenTitle";
import { mountGantt } from "../../tests/fixtures/calendarGanttProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("collapsed Gantt hidden title equality", () => {
    it("acknowledges a real title-only SQL edit, stays visually equal, then exposes it on expand and resets",
        async () => {
            const f = mountGantt(true);
            const latest = () => {
                const value = f.results.at(-1)!;
                if (!value.ready) throw Error(value.reason);
                return value.projection;
            };
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const context = structuredClone(f.context);
            const before = latest();
            const nativeBefore = ganttDom(f.view.container);
            expect(ganttCssObservation(before)).toEqual(nativeBefore);
            expect(before.content.filter(item => item.kind === "row").map(item => item.title))
                .toEqual(["Parent", "Tiny", "Recurring", "Recurring", "Outside"]);
            expect(f.view.queryByText("Grandchild", { selector: ".label-text" })).toBeNull();
            const toggle = () => f.view.getByTestId(`calendar-gantt-collapse-outline_items:${f.parent.key}`);
            expect(toggle().textContent).toBe("▸");
            const parentBar = () => f.view.getByTestId(`calendar-gantt-bar-outline_items:${f.parent.key}`);
            expect([parentBar().style.left, parentBar().style.width]).toEqual(["0%", "26.6667%"]);
            const styles = () =>
                Array.from(f.view.container.querySelectorAll<HTMLElement>(
                    ".gantt-bar,.start-point,.due-marker,.tick-label",
                )).map(node => node.style.cssText);
            const beforeStyles = styles();
            let writes = 0;
            const observe = () => {
                writes++;
            };
            f.map.observeDeep(observe);
            try {
                const acknowledged = await editHiddenGanttTitleAndRead(f, "Hidden descendant revised");
                const original = acknowledged.before.rows.find(row => row.source_id === f.grandchild.key)!;
                const revised = acknowledged.after.rows.find(row => row.source_id === f.grandchild.key)!;
                expect(original.title).toBe("Grandchild");
                expect(revised).toEqual({ ...original, title: "Hidden descendant revised" });
                expect(f.grandchild.text).toBe("Hidden descendant revised");
                const withoutTitle = (rows: typeof acknowledged.after.rows) =>
                    rows.map(row =>
                        row.source_id === f.grandchild.key ? { ...row, title: "omitted hidden title" } : row
                    );
                expect(withoutTitle(acknowledged.after.rows)).toEqual(withoutTitle(acknowledged.before.rows));
                expect(acknowledged.after.columns).toEqual(acknowledged.before.columns);
                const fresh = deriveCalendarVisibleModel({
                    authority: { current: true, result: acknowledged.after, project: f.project },
                    settings: getCalendar(f.project, f.calendarId)!,
                    context: f.context,
                });
                expect(fresh.ready && fresh.model.projection).toEqual(before);

                // Supported navigation reacquires SQL; this does not assert automatic source-only publication.
                await fireEvent.click(f.view.getByTestId("calendar-nav-next"));
                await waitFor(() => expect(latest().rangeLabel).not.toBe(before.rangeLabel));
                const checkpoint = f.results.length;
                await fireEvent.click(f.view.getByTestId("calendar-nav-prev"));
                await waitFor(() => expect(latest().rangeLabel).toBe(before.rangeLabel));
                const accepted = f.results.slice(checkpoint).find(value => value.ready)!;
                expect(accepted.ready && accepted.projection).toEqual(before);
                expect(latest()).toEqual(before);
                expect(ganttDom(f.view.container)).toEqual(nativeBefore);
                expect(styles()).toEqual(beforeStyles);
                expect(toggle().textContent).toBe("▸");
                expect(f.view.queryByText("Hidden descendant revised", { selector: ".label-text" })).toBeNull();
                expect(f.context).toEqual(context);

                // Independent visible positive control: actual new label and literal bar geometry must be reachable.
                await fireEvent.click(toggle());
                await waitFor(() =>
                    expect(f.view.getByText("Hidden descendant revised", { selector: ".label-text" })).toBeTruthy()
                );
                expect(latest().content.find(item => item.kind === "row" && item.title === "Hidden descendant revised"))
                    .toMatchObject({ depth: 2, hasChildren: false, collapsed: false });
                const bar = f.view.getByTestId(`calendar-gantt-bar-outline_items:${f.grandchild.key}`);
                expect([bar.style.left, bar.style.width]).toEqual(["20%", "6.66667%"]);
                expect(latest()).not.toEqual(before);
                expect(ganttCssObservation(latest())).toEqual(ganttDom(f.view.container));
                await fireEvent.click(toggle());
                await waitFor(() => expect(latest()).toEqual(before));
                expect(ganttDom(f.view.container)).toEqual(nativeBefore);
                expect(styles()).toEqual(beforeStyles);
                expect(toggle().textContent).toBe("▸");
                expect(f.grandchild.text).toBe("Hidden descendant revised");
                expect(f.context).toEqual(context);
                expect(writes).toBe(0);
                console.info("hidden-Gantt-title-evidence",
                    JSON.stringify({
                        rawBefore: original.title,
                        rawAfter: revised.title,
                        readyAfterRefresh: accepted.ready,
                        collapsedProjectionEqual: true,
                        expandedNewTitleObserved: true,
                        exactCollapseAndRangeRestored: true,
                        calendarSettingsWrites: writes,
                    }));
            } finally {
                f.map.unobserveDeep(observe);
            }
        }, 45000);
});
