import { expect } from "chai";
import { encodeCalendarObservationContext } from "../../../shared/src/notifications/calendarProjection.js";
import {
    MAX_MOBILE_PAYLOAD_BYTES,
    type MobilePayloadV1,
    validateMobileHref,
    validateMobilePayload,
} from "../../../shared/src/notifications/mobile-payload.js";
import { computeViewRange } from "../../../shared/src/services/calendarGridRange.js";

const target = { projectId: "project-1", kind: "grid" as const, objectId: "grid-1" };
const gridContext = { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" };
const gridHref = `/project-1/-/grids/grid-1?${new URLSearchParams({ observation: JSON.stringify(gridContext) })}`;
const payload: MobilePayloadV1 = {
    schemaVersion: 1,
    eventId: "event-1",
    ruleId: "rule-1",
    enrollmentGeneration: "0123456789abcdefghijklmnopqrstuv",
    target,
    observedAt: "2026-11-26T00:00:00.000Z",
    title: "Grid changed",
    body: "1 displayed position changed. Observed at 2026-11-26T00:00:00.000Z.",
    href: gridHref,
};

describe("mobile payload validation", () => {
    it("accepts the complete bounded wire format and all three saved-context routes", () => {
        expect(validateMobilePayload(payload)).to.equal(payload);
        expect(validateMobileHref(gridHref, target)).to.equal(true);
        const kanban = { projectId: "project-1", kind: "kanban" as const, objectId: "board-1" };
        const boardHref = "/project-1/-/kanbans/board-1?surface=board&version=1&locale=ja-JP&timeZone=Asia%2FTokyo";
        expect(validateMobilePayload({ ...payload, target: kanban, href: boardHref })).not.to.equal(undefined);
        const anchor = Date.UTC(2026, 10, 25, 5);
        const range = computeViewRange(anchor, "month", 1, "Asia/Tokyo");
        const context = encodeCalendarObservationContext({
            version: 1,
            locale: "ja-JP",
            timeZone: "Asia/Tokyo",
            weekStart: 1,
            viewType: "month",
            anchorUtcMs: anchor,
            rangeStartUtcMs: range.start,
            rangeEndUtcMs: range.end,
            monthLaneFilter: "Work",
            collapsedEntryKeys: [],
        });
        const calendar = { projectId: "project-1", kind: "calendar" as const, objectId: "calendar-1" };
        const href = `/project-1/-/calendars/calendar-1?${new URLSearchParams({ context })}`;
        expect(validateMobilePayload({ ...payload, target: calendar, href })).not.to.equal(undefined);
    });

    it("rejects unsafe, unrelated, ambiguous or context-free links without a fallback", () => {
        const invalid = [
            `https://elsewhere.test${gridHref}`,
            `//elsewhere.test${gridHref}`,
            `\\elsewhere.test${gridHref}`,
            `/\\elsewhere.test${gridHref}`,
            ` ${gridHref}`,
            `${gridHref}\n`,
            `${gridHref}#part`,
            `${gridHref}#`,
            "/project-1",
            "/project-1/-/grids/grid-1",
            gridHref.replace("grid-1?", "grid-2?"),
            gridHref.replace("/project-1/", "/project-2/"),
            gridHref.replace("/grids/", "/kanbans/"),
            `${gridHref}&observation=${encodeURIComponent(JSON.stringify(gridContext))}`,
            `${gridHref}&sql=SELECT+1`,
            "/project-1/-/grids/grid-1?observation=%ZZ",
            "/project-1/-/grids/grid-1?observation=%FF",
            `/project-1/-/grids/grid-1?${new URLSearchParams({
                observation: JSON.stringify({ ...gridContext, sql: "SELECT 1" }),
            })}`,
        ];
        for (const href of invalid) {
            expect(validateMobileHref(href, target), href).to.equal(false);
            expect(validateMobilePayload({ ...payload, href }), href).to.equal(undefined);
        }
    });

    it("rejects unverified generations, unsupported schemas, hidden fields and malformed identity/time", () => {
        for (const fields of [
            { schemaVersion: 2 },
            { enrollmentGeneration: "" },
            { enrollmentGeneration: "too-short" },
            { enrollmentGeneration: "a".repeat(129) },
            { enrollmentGeneration: "a".repeat(31) + "/" },
            { uid: "owner-secret" },
            { endpoint: "https://push.example/destination" },
            { target: { ...target, uid: "owner-secret" } },
            { target: { ...target, kind: "page" } },
            { target: { ...target, projectId: "../project-1" } },
            { eventId: "" },
            { observedAt: "yesterday" },
            { observedAt: "2026-11-26" },
            { title: "bad\u0000title" },
            { body: "bad\u001bbody" },
            { title: "a".repeat(81) },
            { body: "a".repeat(1201) },
        ]) expect(validateMobilePayload({ ...payload, ...fields })).to.equal(undefined);
        expect(validateMobilePayload(undefined)).to.equal(undefined);
        expect(validateMobilePayload({ ...payload, body: "Changed: line one\nline two" })).not.to.equal(undefined);
    });

    it("bounds UTF-8 bytes including identifiers, context and JSON escaping", () => {
        const multibyte = { ...payload, body: "界".repeat(1000) };
        expect(new TextEncoder().encode(JSON.stringify(multibyte)).byteLength).to.be.greaterThan(
            MAX_MOBILE_PAYLOAD_BYTES,
        );
        expect(validateMobilePayload(multibyte)).to.equal(undefined);
        const escaped = { ...payload, body: "\\".repeat(1200), ruleId: "a".repeat(200), eventId: "b".repeat(200) };
        expect(new TextEncoder().encode(JSON.stringify(escaped)).byteLength).to.be.greaterThan(
            MAX_MOBILE_PAYLOAD_BYTES,
        );
        expect(validateMobilePayload(escaped)).to.equal(undefined);
    });
});
