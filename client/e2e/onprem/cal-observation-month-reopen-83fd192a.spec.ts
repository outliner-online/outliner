import { expect, test } from "@playwright/test";
import { savedPath } from "./calendarRouteFixture";
import { savedModeContext, savedModeProject } from "./calendarSavedModesFixture";
import { login, stackFor } from "./helpers";

test.use({ timezoneId: "Pacific/Honolulu", locale: "ja-JP" });

test("saved Month filter reopens exact authorized IDs across viewer defaults without settings writes",
    async ({ page, browser }, info) => {
        const stack = stackFor(info);
        await stack.start();
        const author = await browser.newContext({ timezoneId: "America/New_York", locale: "en-US" });
        let writes: ReturnType<typeof stack.watchCalendarWrites> | undefined;
        try {
            const target = savedModeProject("month");
            const context = savedModeContext("month");
            const before = target.project.calendars.toJSON();
            await stack.seedProjectDocument(target.projectId, target.project.title, target.doc);
            writes = stack.watchCalendarWrites(target.projectId);
            const authorPage = await author.newPage();
            await login(authorPage, stack);
            const authorViewer = await authorPage.evaluate(() => ({
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                locale: navigator.language,
            }));
            expect(authorViewer).toEqual({ zone: "America/New_York", locale: "en-US" });
            await authorPage.goto(`${stack.origin}${savedPath(target.projectId, target.calendarId, context)}`);
            await expect(authorPage.getByTestId(`calendar-entry-item:${target.first.key}`)).toBeVisible();
            await expect(authorPage.getByTestId(`calendar-entry-item:${target.other.key}`)).toBeVisible();
            await authorPage.getByTestId("calendar-month-lane-filter").selectOption("Red");
            await expect(authorPage.getByTestId(`calendar-entry-item:${target.other.key}`)).toHaveCount(0);
            const captured = {
                ...context,
                monthLaneFilter: await authorPage.getByTestId("calendar-month-lane-filter").inputValue(),
            };
            expect(captured.monthLaneFilter).toBe("Red");
            const saved = savedPath(target.projectId, target.calendarId, captured);
            await author.close();
            await login(page, stack);
            await page.goto(`${stack.origin}${saved}`);
            await expect(page.getByRole("heading", { name: target.name, exact: true })).toBeVisible();
            expect(new URL(page.url()).pathname).toBe(`/${target.projectId}/-/calendars/${target.calendarId}`);
            await expect(page.getByTestId("calendar-month-grid")).toBeVisible();
            await expect(page.getByTestId("calendar-view-type")).toHaveValue("month");
            await expect(page.getByTestId("calendar-month-lane-filter")).toHaveValue("Red");
            await expect(page.getByTestId(`calendar-entry-item:${target.first.key}`)).toContainText(
                "Month Red visible @ America/New_York [2026-03-30T04:00:00.000Z,2026-05-04T04:00:00.000Z]",
            );
            await expect(
                page.getByTestId("calendar-month-cell-9").getByTestId(`calendar-entry-item:${target.first.key}`),
            ).toBeVisible();
            await expect(page.getByTestId(`calendar-entry-item:${target.other.key}`)).toHaveCount(0);
            await expect(page.getByTestId(/^calendar-entry-item:/)).toHaveCount(1);
            await expect(page.getByTestId(`calendar-entry-item:${target.decoy.key}`)).toHaveCount(0);
            await expect(page.locator(".weekday-label")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
            await expect(page.getByTestId("calendar-active-timezone")).toHaveText("America/New_York");
            await expect(page.getByTestId("calendar-range-label")).toHaveText(
                "Mar 30, 2026 – May 3, 2026 (America/New_York)",
            );
            const viewer = await page.evaluate(() => ({
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                locale: navigator.language,
            }));
            expect(viewer).toEqual({ zone: "Pacific/Honolulu", locale: "ja-JP" });
            const alternate = savedPath(target.projectId, target.calendarId, { ...captured, monthLaneFilter: "Blue" });
            await page.goto(`${stack.origin}${alternate}`);
            await expect(page.getByTestId("calendar-month-lane-filter")).toHaveValue("Blue");
            await expect(page.getByTestId(/^calendar-entry-item:/)).toHaveCount(1);
            await expect(
                page.getByTestId("calendar-month-cell-10").getByTestId(`calendar-entry-item:${target.other.key}`),
            ).toBeVisible();
            await expect(page.getByTestId(`calendar-entry-item:${target.first.key}`)).toHaveCount(0);
            await expect(page.getByTestId(`calendar-entry-item:${target.decoy.key}`)).toHaveCount(0);
            await page.goto(`${stack.origin}${saved}`);
            await expect(page.getByTestId(`calendar-entry-item:${target.first.key}`)).toBeVisible();
            await expect(page.getByTestId(`calendar-entry-item:${target.other.key}`)).toHaveCount(0);
            await expect(page.getByTestId(/^calendar-entry-item:/)).toHaveCount(1);
            expect(writes.count).toBe(0);
            expect((await stack.readProjectDocument(target.projectId))!.getMap("calendars").toJSON()).toEqual(before);
            console.info("saved-month-context-evidence", JSON.stringify({
                projectId: target.projectId,
                calendarId: target.calendarId,
                captured,
                authorViewer,
                viewer,
                calendarWrites: writes.count,
            }));
            await info.attach("saved-month-cross-viewer", {
                contentType: "application/json",
                body: JSON.stringify({
                    saved,
                    projectId: target.projectId,
                    calendarId: target.calendarId,
                    captured,
                    authorViewer,
                    viewer,
                    calendarWrites: writes.count,
                }),
            });
        } finally {
            writes?.dispose();
            await author.close();
            await page.close();
            await stack.stop();
        }
    });
