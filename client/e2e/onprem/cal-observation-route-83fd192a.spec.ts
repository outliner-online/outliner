import { expect, test } from "@playwright/test";
import { calendarProject, savedContext, savedPath } from "./calendarRouteFixture";
import { login, stackFor } from "./helpers";

test.use({ timezoneId: "Pacific/Honolulu", locale: "ja-JP" });

test("saved Calendar URL resolves IDs after renames/title reuse with real room authorization",
    async ({ page }, info) => {
        const stack = stackFor(info);
        await stack.start();
        try {
            const target = calendarProject("route-target", "Original title", "exact-calendar", "Original Calendar");
            const context = savedContext();
            const saved = savedPath("route-target", "exact-calendar", context);
            expect(context.rangeEndUtcMs - context.rangeStartUtcMs).toBe(167 * 3_600_000);
            // Capture the URL first, then rename both targets and reuse their names.
            target.project.title = "Renamed project";
            target.project.calendars.get("exact-calendar")!.set("name", "Renamed Calendar");
            target.project.calendars.get("exact-calendar")!.set("query",
                "SELECT id AS id, text || ' @ ' || current_setting('TimeZone') || ' [' || "
                    + "current_setting('view.range_start') || ',' || current_setting('view.range_end') || ']' AS title, "
                    + "all_day AS all_day, start_at AS start_at, duration AS duration, "
                    + "'item' AS source_kind, id AS source_id FROM outline_items");
            const collision = calendarProject("route-reused", "Original title", "other-calendar", "exact-calendar");
            target.project.calendars.set("name-collision", collision.project.calendars.get("other-calendar")!.clone());
            const wrongIdName = collision.project.calendars.get("other-calendar")!.clone();
            wrongIdName.set("name", "missing-calendar");
            target.project.calendars.set("wrong-id-name", wrongIdName);
            await stack.seedProjectDocument("route-target", "Renamed project", target.doc);
            await stack.seedProjectDocument("route-reused", "Original title", collision.doc);
            const denied = calendarProject("route-inaccessible", "Private project", "exact-calendar",
                "Private Calendar");
            await stack.seedProjectDocument("route-inaccessible", "Private project", denied.doc, false);
            const decoy = calendarProject("route-decoy", "route-inaccessible", "exact-calendar", "Decoy Calendar");
            await stack.seedProjectDocument("route-decoy", "route-inaccessible", decoy.doc);
            const before = target.project.calendars.toJSON();
            const remoteRequests: string[] = [];
            page.on("request", request => {
                if (new URL(request.url()).origin !== stack.origin) remoteRequests.push(request.url());
            });
            await login(page, stack);
            await page.goto(`${stack.origin}${saved}`);
            await expect(page.getByRole("heading", { name: "Renamed Calendar", exact: true })).toBeVisible();
            await expect(page.getByTestId(`calendar-entry-item:${target.itemId}`)).toContainText(
                "Original Calendar entry @ America/New_York [2026-03-02T05:00:00.000Z,2026-03-09T04:00:00.000Z]",
            );
            await expect(page.getByTestId("calendar-active-timezone")).toHaveText("America/New_York");
            await expect(page.getByTestId("calendar-range-label")).toHaveText(
                "Mar 2, 2026 – Mar 8, 2026 (America/New_York)",
            );
            await expect(page.getByTestId("calendar-time-grid")).toBeVisible();
            expect(await page.evaluate(() => ({
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                locale: navigator.language,
            }))).toEqual({ zone: "Pacific/Honolulu", locale: "ja-JP" });
            expect((await stack.readProjectDocument("route-target"))!.getMap("calendars").toJSON()).toEqual(before);
            expect(
                stack.transportSnapshot().some(event =>
                    event.kind === "ws-upstream-data" && event.url.includes("projects/route-target")
                ),
            ).toBe(true);

            // Wrong ID must not select a Calendar whose NAME matches it.
            await page.goto(`${stack.origin}${savedPath("route-target", "missing-calendar")}`);
            await expect(page.getByRole("heading", { name: "Calendar not found" })).toBeVisible();
            await expect(page.getByTestId("calendar-time-grid")).toHaveCount(0);
            // A different admitted Project has the matching name, but not the exact ID.
            await page.goto(`${stack.origin}${savedPath("route-reused", "exact-calendar")}`);
            await expect(page.getByRole("heading", { name: "Calendar not found" })).toBeVisible();
            await expect(page.getByTestId("calendar-time-grid")).toHaveCount(0);
            // No admitted Project: actual room authentication refuses this ID.
            await page.goto(`${stack.origin}${savedPath("route-inaccessible", "exact-calendar")}`);
            await expect(page.getByRole("heading", { name: "Calendar not found" })).toBeVisible();
            await expect(page.getByTestId("calendar-time-grid")).toHaveCount(0);
            // Ordinary links keep their legacy project-title/Calendar-name resolution.
            await page.goto(`${stack.origin}/Original%20title/-/calendars/exact-calendar`);
            await expect(page.getByRole("heading", { name: "exact-calendar", exact: true })).toBeVisible();
            await expect(page.getByTestId("calendar-active-timezone")).toHaveText("Asia/Tokyo");

            const invalid = new URL(saved, stack.origin);
            invalid.searchParams.set("context",
                JSON.stringify({ ...context, rangeEndUtcMs: context.rangeEndUtcMs + 3_600_000 }));
            await page.goto(invalid.href);
            await expect(page.getByTestId("calendar-context-error")).toBeVisible();
            await expect(page.getByTestId("calendar-time-grid")).toHaveCount(0);
            expect(remoteRequests).toEqual([]);
        } finally {
            await page.close();
            await stack.stop();
        }
    });
