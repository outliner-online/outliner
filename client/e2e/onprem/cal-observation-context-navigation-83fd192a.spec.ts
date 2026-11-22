import { expect, test } from "@playwright/test";
import { Items } from "../../../shared/src/app-schema";
import { computeViewRange } from "../../../shared/src/services/calendarGridRange";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { calendarProject, savedContext, savedPath } from "./calendarRouteFixture";
import { login, stackFor } from "./helpers";

registerCoverageHooks();

test.use({ timezoneId: "Pacific/Honolulu", locale: "ja-JP" });

test("same Calendar context-only navigation restores a changed saved date and view without settings writes",
    async ({ page }, info) => {
        const stack = stackFor(info);
        await stack.start();
        let writes: ReturnType<typeof stack.watchCalendarWrites> | undefined;
        const openedRooms: string[] = [];
        const documentNavigations: string[] = [];
        try {
            const target = calendarProject("context-target", "Context project", "same-calendar", "Same Calendar");
            const laterPage = new Items(target.doc, target.project.tree, "root").addNode("fixture");
            laterPage.text = "Later page";
            const later = new Items(target.doc, target.project.tree, laterPage.key).addNode("fixture");
            later.text = "Next saved day entry";
            later.start = "2026-03-09T13:00:00.000Z";
            later.duration = "PT30M";
            later.allDay = false;
            const first = savedContext();
            const anchorUtcMs = Date.UTC(2026, 2, 9, 12);
            const range = computeViewRange(anchorUtcMs, "day", first.weekStart, first.timeZone);
            const second = {
                ...first,
                viewType: "day" as const,
                anchorUtcMs,
                rangeStartUtcMs: range.start,
                rangeEndUtcMs: range.end,
            };
            const firstPath = savedPath("context-target", "same-calendar", first);
            const secondPath = savedPath("context-target", "same-calendar", second);
            expect(new URL(firstPath, stack.origin).pathname).toBe(new URL(secondPath, stack.origin).pathname);
            // Server-supplied fixture anchors only control navigation. The real
            // application's delegated SvelteKit router handles these clicks.
            stack.fixtureNavigationLinks = [{ label: "Open next saved context", href: secondPath }];
            const before = target.project.calendars.toJSON();
            await stack.seedProjectDocument("context-target", "Context project", target.doc);
            writes = stack.watchCalendarWrites("context-target");
            await login(page, stack);
            page.on("websocket", socket => {
                const room = new URL(socket.url()).pathname;
                if (room.endsWith("/projects/context-target")) openedRooms.push(room);
            });
            await page.goto(`${stack.origin}${firstPath}`);
            await expect(page.getByTestId(`calendar-entry-item:${target.itemId}`)).toBeVisible();
            await expect(page.getByTestId(`calendar-entry-item:${later.key}`)).toHaveCount(0);
            await expect(page.getByTestId(/^calendar-day-header-\d+$/)).toHaveCount(7);
            const timeOrigin = await page.evaluate(() => performance.timeOrigin);
            page.on("request", request => {
                if (request.isNavigationRequest() && request.resourceType() === "document") {
                    documentNavigations.push(request.url());
                }
            });
            await page.getByRole("navigation", { name: "Fixture observation links" })
                .getByRole("link", { name: "Open next saved context", exact: true }).click();
            await expect(page).toHaveURL(`${stack.origin}${secondPath}`);
            await expect(page.getByRole("heading", { name: "Same Calendar", exact: true })).toBeVisible();
            await expect(page.getByTestId("calendar-range-label")).toHaveText(
                "Mar 9, 2026 – Mar 9, 2026 (America/New_York)",
            );
            await expect(page.getByTestId(/^calendar-day-header-\d+$/)).toHaveCount(1);
            await expect(page.getByTestId(`calendar-entry-item:${later.key}`)).toContainText("Next saved day entry");
            await expect(page.getByTestId(`calendar-entry-item:${target.itemId}`)).toHaveCount(0);
            expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
            expect(documentNavigations).toEqual([]);
            expect(openedRooms.length).toBeLessThanOrEqual(2);
            expect(writes.count).toBe(0);
            expect((await stack.readProjectDocument("context-target"))!.getMap("calendars").toJSON()).toEqual(before);
        } finally {
            await info.attach("same-calendar-context-observation", {
                contentType: "application/json",
                body: JSON.stringify({ openedRooms, documentNavigations, calendarWrites: writes?.count }),
            });
            writes?.dispose();
            await page.close();
            await stack.stop();
        }
    });
