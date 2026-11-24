import { expect } from "chai";
import { describe, it } from "mocha";
import { deriveCalendarVisibleModel } from "../dist/shared/src/notifications/calendarVisibleModel.js";
import { todayAnchor } from "../dist/shared/src/services/calendarGridRange.js";
import { calendarInput } from "./calendar-visible-model-fixture.js";

// Separate stable view range from the two occurrences of local 00:30 at Gaza's repeated midnight.
describe("compiled comparable Calendar state excludes transient today decoration", () => {
    for (const mode of ["day", "hours", "gantt"]) {
        it(`${mode}: remains ready at the first midnight occurrence and equal at the later occurrence`, () => {
            const { input } = calendarInput(mode);
            input.context.timeZone = "Asia/Gaza";
            input.context.anchorUtcMs = Date.parse("2021-10-26T12:00:00Z");
            input.context.rangeStartUtcMs = Date.parse("2021-10-25T21:00:00Z");
            input.context.rangeEndUtcMs = Date.parse(
                mode === "gantt" ? "2021-11-24T22:00:00Z" : "2021-10-26T21:00:00Z",
            );
            input.authority.result.rows[0].start = "2021-10-26T09:00:00Z";
            const firstClock = Date.parse("2021-10-28T21:30:00Z");
            const laterClock = Date.parse("2021-10-28T22:30:00Z");
            const nativeToday = todayAnchor("Asia/Gaza", firstClock);
            expect(nativeToday).to.equal(Date.parse("2021-10-28T22:00:00Z"));
            expect(nativeToday).to.be.greaterThan(firstClock);
            expect(todayAnchor("Asia/Gaza", laterClock)).to.equal(nativeToday);
            // Extra JS clock property reproduces the former API. Comparable input must not consume this decoration.
            const first = deriveCalendarVisibleModel({ ...input, nowUtcMs: firstClock });
            const later = deriveCalendarVisibleModel({ ...input, nowUtcMs: laterClock });
            console.info("Gaza-clock-seam",
                JSON.stringify({
                    mode,
                    nativeToday,
                    firstClock,
                    firstReady: first.ready,
                    firstReason: first.reason,
                    laterReady: later.ready,
                }));
            expect(later.ready).to.equal(true);
            expect(first.ready).to.equal(true);
            expect(first.model.projection.content.some(item => item.title === "Accepted SQL title")).to.equal(true);
            expect(first.model.projection).to.deep.equal(later.model.projection);
            if (mode === "day") {
                expect(first.model.projection.content[0]).to.deep.equal({
                    kind: "timed",
                    title: "Accepted SQL title",
                    day: 0,
                    start: 0.5,
                    end: 12.5 / 24,
                    column: 0,
                    columns: 1,
                });
            }
        });
    }
});
