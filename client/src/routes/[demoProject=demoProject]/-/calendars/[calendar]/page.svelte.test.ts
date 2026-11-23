import { encodeCalendarObservationContext } from "$shared/notifications/calendarProjection";
import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import { computeViewRange } from "../../../../../services/calendar/calendarGridRange";
import { setPage } from "../../../../../tests/mocks/appState.svelte";

vi.mock("$app/state", () => import("../../../../../tests/mocks/appState.svelte"));
vi.mock("../../../../../components/management/CalendarDetailView.svelte",
    () => import("../../../../../tests/fixtures/CalendarDetailViewProbe.svelte"));

import DemoCalendarPage from "./+page.svelte";

afterEach(cleanup);

it("validates and forwards a demo observation context instead of using local defaults", async () => {
    const anchorUtcMs = Date.parse("2026-03-16T12:00:00Z");
    const range = computeViewRange(anchorUtcMs, "day", 1, "America/New_York");
    const context = {
        version: 1 as const,
        locale: "en-US",
        timeZone: "America/New_York",
        weekStart: 1,
        viewType: "day" as const,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
    setPage({
        params: { demoProject: "demo", calendar: "exact-calendar-id" },
        url: `/demo/-/calendars/exact-calendar-id?context=${
            encodeURIComponent(encodeCalendarObservationContext(context))
        }`,
    });
    render(DemoCalendarPage);
    await waitFor(() =>
        expect(screen.getByTestId("calendar-detail-probe").textContent).toContain(
            "demo:exact-calendar-id:day:America/New_York",
        )
    );

    setPage({ url: "/demo/-/calendars/exact-calendar-id?context=%7Binvalid" });
    await waitFor(() => expect(screen.getByTestId("calendar-context-error")).toBeTruthy());
    expect(screen.queryByTestId("calendar-detail-probe")).toBeNull();
});
