import { expect } from "chai";
import { describe, it } from "mocha";
import { deriveCalendarVisibleModel } from "../dist/shared/src/notifications/calendarVisibleModel.js";
import { calendarInput, modes } from "./calendar-visible-model-fixture.js";

// Native Node ESM imports actual ES2020 output: no browser, bundler, alias loader or visible-state adapter.
describe("compiled Calendar production dispatcher", () => {
    const labels = { day: "day", hours: "Hour Map", days: "Multi-day", week: "Week", month: "Month", gantt: "Gantt" };
    for (const mode of modes) {
        it(`${mode}: derives accepted structure with a canonical DST context independent of today decoration`, () => {
            const { input } = calendarInput(mode);
            const value = deriveCalendarVisibleModel(input);
            expect(value.ready).to.equal(true);
            expect(value.kind).to.equal(mode === "week" ? "days" : mode);
            expect(value.model.projection.modeLabel).to.equal(labels[mode]);
            expect(value.model.projection.title).to.equal("Authorized Calendar");
            expect(value).not.to.have.property("todayUtcMs");
            expect(value.model.projection.content.some(item => item.title === "Accepted SQL title")).to.equal(true);
            expect(Object.isFrozen(value.model.projection.content)).to.equal(true);
            expect(globalThis.window).to.equal(undefined);
        });
        it(`${mode}: accepts complete empty SQL but refuses absent/stale authority and shifted DST ranges`, () => {
            const { input } = calendarInput(mode);
            input.authority.result.rows = [];
            expect(deriveCalendarVisibleModel(input).ready).to.equal(true);
            expect(deriveCalendarVisibleModel({ ...input, authority: undefined })).to.deep.equal({
                ready: false,
                reason: "Accepted Calendar SQL evidence is stale or unavailable.",
            });
            expect(deriveCalendarVisibleModel({ ...input, authority: { ...input.authority, current: false } }).ready)
                .to.equal(false);
            const shifted = {
                ...input.context,
                rangeStartUtcMs: input.context.rangeStartUtcMs + 3600000,
                rangeEndUtcMs: input.context.rangeEndUtcMs + 3600000,
            };
            expect(deriveCalendarVisibleModel({ ...input, context: shifted })).to.deep.equal({
                ready: false,
                reason: "Calendar range is not coherent with its anchor and view settings.",
            });
        });
        it(`${mode}: expands committed recurrence and refuses unresolved outline authority/parent`, () => {
            const { input, page } = calendarInput(mode, true);
            const value = deriveCalendarVisibleModel(input);
            expect(value.ready).to.equal(true);
            const expectedKind = mode === "hours"
                ? "fragment"
                : mode === "month"
                ? "entry"
                : mode === "gantt"
                ? "row"
                : "timed";
            expect(
                value.model.projection.content.filter(item =>
                    item.kind === expectedKind && item.title === "Accepted SQL title"
                ),
            )
                .to.have.length(2);
            page.id = "unhydrated-parent-identity";
            expect(deriveCalendarVisibleModel(input)).to.deep.equal({
                ready: false,
                reason: "Calendar recurrence outline evidence is unavailable.",
            });
            expect(
                deriveCalendarVisibleModel({ ...input, authority: { ...input.authority, project: undefined } }).ready,
            )
                .to.equal(false);
        });
    }
});
