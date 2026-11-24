import { deriveCalendarVisibleModel } from "$shared/notifications/calendarVisibleModel";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getCalendar } from "../../services/calendar/calendarService";
import { globalUndoRouter } from "../../services/undo/undoRouter.svelte";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { createHoursOverrideAndRead } from "../../tests/fixtures/calendarHoursOverride";
import { hoursDom, mountHours } from "../../tests/fixtures/calendarHoursProjection";

configure({ asyncUtilTimeout: 15000 });
afterEach(async () => {
    cleanup();
    await resetTableEngineForTests();
    globalUndoRouter.clear();
});
afterAll(resetPgliteForTests);

describe("already-ready Hours occurrence override", () => {
    it("acknowledges the real owner write in SQL and changes only the chosen occurrence after supported refresh",
        async () => {
            const f = mountHours({ postReadyRecurrence: true });
            const latest = () => {
                const value = f.results.at(-1)!;
                if (!value.ready) throw Error(value.reason);
                return value.projection;
            };
            await waitFor(() => expect(f.results.at(-1)?.ready).toBe(true));
            const before = latest();
            expect(before).toEqual(hoursDom(f.view.container));
            const series = (value: typeof before) =>
                value.content.filter(item => item.kind === "fragment" && item.label === "Series");
            expect(series(before).map(item => item.row)).toEqual([7, 8, 9]);
            expect(series(before)[1]).toEqual({
                kind: "fragment",
                row: 8,
                start: 0,
                end: 30,
                lane: 0,
                lanes: 1,
                title: "Series",
                label: "Series",
                first: true,
                last: true,
            });
            expect(before.content.some(item => item.title === "Moved one occurrence")).toBe(false);
            const untouchedOccurrence = series(before)[0];
            const unrelated = before.content.find(item => item.label === "Clipped");
            expect(unrelated).toMatchObject({ row: 22, start: 30, end: 60 });
            const checkpoint = f.results.length;
            const acknowledged = await createHoursOverrideAndRead(f);
            expect(acknowledged.before.rows.some(row => row.recurrence_parent_id != null)).toBe(false);
            const raw = acknowledged.after.rows.find(row => row.source_id === acknowledged.override.key)!;
            expect(raw).toMatchObject({
                title: "Moved one occurrence",
                duration: "00:20:00",
                recurrence_parent_id: f.recurring.id,
                recurrence_occurrence_id: "2026-03-08T09:00:00",
            });
            expect(Date.parse(String(raw.start_value))).toBe(Date.parse("2026-03-08T19:15:00Z"));
            expect(acknowledged.after.rows.filter(row => row.source_id === f.recurring.key)).toHaveLength(1);
            expect(acknowledged.override.rrule).toBeUndefined();
            expect(acknowledged.override.duration).toBe("PT20M");
            expect(acknowledged.occurrence.startUtcMs).toBe(Date.parse("2026-03-08T13:00:00Z"));

            // Actual supported navigation reacquires the original range; no claim of automatic source-only refresh.
            await fireEvent.click(f.view.getByTestId("calendar-nav-next"));
            await waitFor(() => expect(latest().rangeLabel).not.toBe(before.rangeLabel));
            const refreshCheckpoint = f.results.length;
            await fireEvent.click(f.view.getByTestId("calendar-nav-prev"));
            await waitFor(() => {
                expect(latest().rangeLabel).toBe(before.rangeLabel);
                expect(latest().content.some(item => item.title === "Moved one occurrence")).toBe(true);
            });
            const accepted = f.results.slice(refreshCheckpoint).find(value => value.ready)!;
            if (!accepted.ready) throw Error("Missing next accepted output after supported refresh");
            const after = accepted.projection;
            expect(after).toEqual(latest());
            expect(after).toEqual(hoursDom(f.view.container));
            const settings = getCalendar(f.project, f.calendarId)!;
            const fresh = deriveCalendarVisibleModel({
                authority: { current: true, result: acknowledged.after, project: f.project },
                settings,
                context: f.context,
            });
            expect(fresh.ready && fresh.model.projection).toEqual(after);
            expect(series(after).map(item => item.row)).toEqual([7, 9]);
            expect(after.content.find(item => item.label === "Moved one occurrence")).toEqual({
                kind: "fragment",
                row: 14,
                start: 15,
                end: 35,
                lane: 0,
                lanes: 1,
                title: "Moved one occurrence",
                label: "Moved one occurrence",
                first: true,
                last: true,
            });
            expect(series(after)[0]).toEqual(untouchedOccurrence);
            expect(after.content.find(item => item.label === "Clipped")).toEqual(unrelated);
            const retained = (value: typeof before) => ({
                ...value,
                content: value.content.filter(item =>
                    !(item.kind === "fragment"
                        && ((item.label === "Series" && item.row === 8) || item.label === "Moved one occurrence"))
                ),
            });
            expect(retained(after)).toEqual(retained(before));
            const rows = f.view.container.querySelectorAll(".hour-row");
            expect(rows[8].querySelector('[aria-label="Series"]')).toBeNull();
            const moved = rows[14].querySelector<HTMLElement>('[aria-label="Moved one occurrence"]')!;
            expect([moved.style.left, moved.style.width]).toEqual(["25%", "33.3333%"]);
            expect(before.content).not.toEqual(after.content);
            console.info("post-ready-override-evidence", JSON.stringify({
                readyBeforeMutation: true,
                initialOverrideRows: acknowledged.before.rows.filter(row => row.recurrence_parent_id != null).length,
                rawOverrideTitle: raw.title,
                rawOverrideStart: raw.start_value,
                rawOccurrence: raw.recurrence_occurrence_id,
                publicationsAfterOwnerWriteAndRefresh: f.results.length - checkpoint,
                oldOccurrenceRow: 8,
                newOccurrenceRow: 14,
                retainedOccurrenceRow: 7,
                retainedUnrelatedRow: 22,
            }));
        }, 45000);
});
