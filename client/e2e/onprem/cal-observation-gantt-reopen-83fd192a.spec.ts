import { expect, test } from "@playwright/test";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { savedPath } from "./calendarRouteFixture";
import { savedModeContext, savedModeProject } from "./calendarSavedModesFixture";
import { login, stackFor } from "./helpers";

registerCoverageHooks();

test.use({ timezoneId: "Pacific/Honolulu", locale: "ja-JP" });

test("saved native Gantt collapse key reopens exact hierarchy across viewer defaults without settings writes",
    async ({ page, browser }, info) => {
        const stack = stackFor(info);
        await stack.start();
        const author = await browser.newContext({ timezoneId: "America/New_York", locale: "en-US" });
        let writes: ReturnType<typeof stack.watchCalendarWrites> | undefined;
        try {
            const target = savedModeProject("gantt");
            const expanded = savedModeContext("gantt");
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
            await authorPage.goto(`${stack.origin}${savedPath(target.projectId, target.calendarId, expanded)}`);
            await expect(authorPage.getByTestId(`calendar-gantt-row-item:${target.other.key}`)).toBeVisible();
            // Capture the key emitted by the actual production layout/row, not a title-derived or guessed key.
            const parentToggle = authorPage.getByTestId(/^calendar-gantt-collapse-/);
            const nativeKey = (await parentToggle.getAttribute("data-testid"))!.slice(
                "calendar-gantt-collapse-".length,
            );
            expect(nativeKey).toBe(`item:${target.first.key}`);
            await parentToggle.click();
            await expect(parentToggle).toHaveText("▸");
            await expect(authorPage.getByTestId(`calendar-gantt-row-item:${target.other.key}`)).toHaveCount(0);
            const captured = { ...expanded, collapsedEntryKeys: [nativeKey] };
            const saved = savedPath(target.projectId, target.calendarId, captured);
            await author.close();
            await login(page, stack);
            await page.goto(`${stack.origin}${saved}`);
            await expect(page.getByRole("heading", { name: target.name, exact: true })).toBeVisible();
            expect(new URL(page.url()).pathname).toBe(`/${target.projectId}/-/calendars/${target.calendarId}`);
            await expect(page.getByTestId("calendar-gantt-chart")).toBeVisible();
            await expect(page.getByTestId("calendar-view-type")).toHaveValue("gantt");
            await expect(page.getByTestId("calendar-gantt-scale")).toHaveValue("day");
            await expect(page.getByTestId(`calendar-gantt-collapse-${nativeKey}`)).toHaveText("▸");
            await expect(page.locator(".gantt-row")).toHaveCount(1);
            await expect(page.getByTestId(`calendar-gantt-row-${nativeKey}`)).toContainText(
                "Gantt Parent @ America/New_York [2026-04-01T04:00:00.000Z,2026-05-01T04:00:00.000Z]",
            );
            await expect(page.getByTestId(`calendar-gantt-row-item:${target.other.key}`)).toHaveCount(0);
            await expect(page.getByTestId(`calendar-gantt-row-item:${target.secondChild!.key}`)).toHaveCount(0);
            await expect(page.getByTestId(`calendar-gantt-row-item:${target.decoy.key}`)).toHaveCount(0);
            const rollup = page.getByTestId(`calendar-gantt-bar-${nativeKey}`);
            await expect(rollup).toHaveClass(/rollup/);
            expect(await rollup.evaluate(node => [(node as HTMLElement).style.left, (node as HTMLElement).style.width]))
                .toEqual(["11.25%", "13.3333%"]);
            await expect(page.locator(".tick-label")).toHaveCount(30);
            await expect(page.locator(".tick-label").first()).toHaveText("Apr 1");
            await expect(page.getByTestId("calendar-active-timezone")).toHaveText("America/New_York");
            await expect(page.getByTestId("calendar-range-label")).toHaveText(
                "Apr 1, 2026 – Apr 30, 2026 (America/New_York)",
            );
            const viewer = await page.evaluate(() => ({
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                locale: navigator.language,
            }));
            expect(viewer).toEqual({ zone: "Pacific/Honolulu", locale: "ja-JP" });
            await page.goto(`${stack.origin}${savedPath(target.projectId, target.calendarId, expanded)}`);
            await expect(page.getByTestId(`calendar-gantt-collapse-${nativeKey}`)).toHaveText("▾");
            await expect(page.locator(".gantt-row")).toHaveCount(3);
            await expect(page.getByTestId(`calendar-gantt-row-item:${target.other.key}`)).toContainText(
                "Gantt hidden child @ America/New_York",
            );
            await expect(page.getByTestId(`calendar-gantt-row-item:${target.secondChild!.key}`)).toBeVisible();
            await expect(page.getByTestId(`calendar-gantt-row-item:${target.decoy.key}`)).toHaveCount(0);
            await page.goto(`${stack.origin}${saved}`);
            await expect(page.getByTestId(`calendar-gantt-collapse-${nativeKey}`)).toHaveText("▸");
            await expect(page.locator(".gantt-row")).toHaveCount(1);
            expect(writes.count).toBe(0);
            expect((await stack.readProjectDocument(target.projectId))!.getMap("calendars").toJSON()).toEqual(before);
            console.info("saved-gantt-context-evidence", JSON.stringify({
                projectId: target.projectId,
                calendarId: target.calendarId,
                captured,
                authorViewer,
                viewer,
                calendarWrites: writes.count,
            }));
            await info.attach("saved-gantt-cross-viewer", {
                contentType: "application/json",
                body: JSON.stringify({
                    saved,
                    projectId: target.projectId,
                    calendarId: target.calendarId,
                    nativeKey,
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
