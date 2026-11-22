import { deriveCalendarHoursVisibleModel } from "$shared/notifications/calendarHoursVisibleModel";
import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";
import { deriveAcceptedCalendarEntries } from "$shared/services/calendarAcceptedEntries";
import { computeViewRange } from "$shared/services/calendarGridRange";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Items, Project } from "../../schema/app-schema";
import { buildCalendarEntries } from "./calendarEntries";

function fixture() {
    const project = Project.fromDoc(new Y.Doc());
    const page = new Items(project.ydoc, project.tree, "root").addNode("fixture");
    const source = new Items(project.ydoc, project.tree, page.key).addNode("fixture");
    source.text = "Source text differs from the SQL title";
    source.rrule = "FREQ=HOURLY;INTERVAL=2;COUNT=2";
    source.recurrenceDtstart = "2026-03-08T08:00:00";
    source.recurrenceTimezone = "America/New_York";
    source.duration = "PT30M";
    const anchorUtcMs = Date.UTC(2026, 2, 8, 16);
    const range = computeViewRange(anchorUtcMs, "hours", 1, "America/New_York");
    const context: CalendarObservationContextV1 = {
        version: 1,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "hours",
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
    const row = {
        title: "Accepted SQL title",
        start: "2026-03-08T12:00:00Z",
        duration: "00:30:00",
        source_kind: "outline_items",
        source_id: source.key,
        parent_id: page.key,
        rrule: source.rrule,
        recurrence_dtstart: source.recurrenceDtstart,
        recurrence_timezone: source.recurrenceTimezone,
    };
    const settings = { name: "Hours", roleTitle: "title", roleStart: "start", roleDuration: "duration" };
    const evidence = { current: true, project, context, settings, result: { columns: Object.keys(row), rows: [row] } };
    const accepted = () => deriveAcceptedCalendarEntries({
        ...evidence,
        timeZone: context.timeZone,
        range: { startUtcMs: range.start, endUtcMs: range.end },
    });
    return { project, page, source, row, evidence, accepted, range };
}

const unavailable = { ready: false, reason: "Calendar recurrence outline evidence is unavailable." };

describe("authoritative recurring outline evidence", () => {
    it("refuses a non-null unrelated Project without changing interactive anchor fallback", () => {
        const { evidence, range } = fixture();
        const project = Project.fromDoc(new Y.Doc());
        expect(buildCalendarEntries(evidence.result, evidence.settings, evidence.context.timeZone, project, {
            startUtcMs: range.start,
            endUtcMs: range.end,
        })).toMatchObject([{ title: "Accepted SQL title", startMs: Date.parse("2026-03-08T12:00:00Z") }]);
        expect(deriveCalendarHoursVisibleModel({ ...evidence, project })).toEqual(unavailable);
    });

    it.each(["source payload", "source identity", "parent payload", "parent identity", "dtstart", "timezone"])(
        "refuses unresolved %s even with a non-null Project and structural node keys",
        failure => {
            const { project, source, page, evidence, accepted } = fixture();
            if (failure.endsWith("payload")) {
                const key = failure.startsWith("source") ? source.key : page.key;
                project.ydoc.getMap<Y.Map<unknown>>("orderedTree").get(key)!.delete("value");
            }
            if (failure === "source identity") source.id = "another-item";
            if (failure === "parent identity") page.id = "another-page";
            if (failure === "dtstart") source.recurrenceDtstart = undefined;
            if (failure === "timezone") source.recurrenceTimezone = undefined;
            expect(accepted()).toEqual(unavailable); // shared comparable boundary, including Day
            expect(deriveCalendarHoursVisibleModel(evidence)).toEqual(unavailable);
        },
    );

    it.each(["parent_id", "rrule", "recurrence_dtstart", "recurrence_timezone"])(
        "refuses mismatched accepted %s",
        field => {
            const { row, accepted } = fixture();
            Object.assign(row, { [field]: "mismatch" });
            expect(accepted()).toEqual(unavailable);
        },
    );

    it("expands complete source into two independently expected DST Hours fragments", () => {
        const { evidence, accepted } = fixture();
        expect(accepted()).toMatchObject({
            ready: true,
            entries: [
                { title: "Accepted SQL title", startMs: Date.parse("2026-03-08T12:00:00Z"), durationMs: 1_800_000 },
                { title: "Accepted SQL title", startMs: Date.parse("2026-03-08T14:00:00Z"), durationMs: 1_800_000 },
            ],
        });
        const result = deriveCalendarHoursVisibleModel(evidence);
        expect(result.ready).toBe(true);
        expect(result.ready && result.model.projection.content.filter(value => value.kind === "fragment"))
            .toMatchObject([
                { row: 7, start: 0, end: 30, title: "Accepted SQL title" },
                { row: 9, start: 0, end: 30, title: "Accepted SQL title" },
            ]);
    });

    it("accepts a complete source directly under the structural root without an Item payload on root", () => {
        const { project, source, row, accepted } = fixture();
        project.tree.moveChildToParent(source.key, "root");
        Object.assign(row, { parent_id: null });
        expect(accepted()).toMatchObject({ ready: true, entries: [{}, {}] });
    });

    it("re-evaluates a source-only EXDATE edit and refuses old SQL after a source rule edit", () => {
        const { evidence, source, row, accepted } = fixture();
        expect(accepted()).toMatchObject({ ready: true, entries: [{}, {}] });
        // Same accepted rows; explicit producer re-evaluation, not a claim about UI notification timing.
        source.addRecurrenceExdate("2026-03-08T08:00:00");
        const result = deriveCalendarHoursVisibleModel(evidence);
        expect(result.ready && result.model.projection.content.filter(value => value.kind === "fragment"))
            .toMatchObject([{ row: 9, start: 0, end: 30 }]);
        source.rrule = "FREQ=HOURLY;INTERVAL=2;COUNT=3";
        expect(accepted()).toEqual(unavailable);
        row.rrule = source.rrule;
        expect(accepted()).toMatchObject({ ready: true, entries: [{}, {}] });
    });
});
