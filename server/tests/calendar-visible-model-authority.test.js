import { expect } from "chai";
import { describe, it } from "mocha";
import { deriveCalendarVisibleModel } from "../dist/shared/src/notifications/calendarVisibleModel.js";
import { calendarInput } from "./calendar-visible-model-fixture.js";

describe("compiled Calendar structural authority and clock", () => {
    it("derives Day labels from settings/context and ignores fabricated visible text", () => {
        const { input } = calendarInput();
        const value = deriveCalendarVisibleModel({
            ...input,
            title: "Forged title",
            rangeLabel: "Forged range",
            visible: { title: "Forged", content: [] },
        });
        expect(value.ready).to.equal(true);
        expect(value.model.projection.title).to.equal("Authorized Calendar");
        expect(value.model.projection.rangeLabel).to.equal("Mar 8, 2026 – Mar 8, 2026 (America/New_York)");
        expect(deriveCalendarVisibleModel({ ...input, authority: undefined, visible: value.model.projection }).ready).to
            .equal(false);
        const later = deriveCalendarVisibleModel({ ...input, nowUtcMs: Date.parse("2026-03-09T16:00:00Z") });
        expect(later).not.to.have.property("todayUtcMs");
        expect(later.model.projection).to.deep.equal(value.model.projection);
    });
    for (const nowUtcMs of [undefined, NaN, Infinity, 1e20, -8640000000000000]) {
        it(`keeps irrelevant transient clock ${String(nowUtcMs)} outside comparable readiness`, () => {
            const { input } = calendarInput();
            const baseline = deriveCalendarVisibleModel(input);
            const observed = deriveCalendarVisibleModel({ ...input, nowUtcMs });
            expect(observed.ready).to.equal(true);
            expect(observed.model.projection).to.deep.equal(baseline.model.projection);
            expect(observed).not.to.have.property("todayUtcMs");
        });
    }

    it("routes grouped Day to native ordered/empty bands and holds absent grouping evidence", () => {
        const { input } = calendarInput();
        input.settings.groupAxes = ["team", "unselected_deeper_axis"];
        input.settings.laneOrder = ["B", "Empty", "A"];
        input.settings.showEmptyLanes = true;
        const value = deriveCalendarVisibleModel(input);
        expect(value.ready).to.equal(true);
        expect(value.kind).to.equal("days");
        expect(value.model.projection.modeLabel).to.equal("Day");
        expect(value.model.bands.map(band => band.label)).to.deep.equal(["B", "Empty", "A"]);
        expect(value.model.projection.content.find(item => item.title === "Accepted SQL title").lane).to.equal(2);
        input.authority.result.rows = [];
        expect(deriveCalendarVisibleModel(input).model.bands.map(band => band.label)).to.deep.equal(["B", "Empty",
            "A"]);
        input.authority.result.columns = [];
        expect(deriveCalendarVisibleModel(input)).to.deep.equal({
            ready: false,
            reason: "Calendar grouping evidence is unavailable or ambiguous.",
        });
    });
});
