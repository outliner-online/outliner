/** @feature CLP-4584c0de */
import { expect, test } from "@playwright/test";
import { goHome, openProjectPage, seedCrossProjectFixture } from "../utils/crossProjectGridHelpers";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";

registerCoverageHooks();

test("Home re-entry keeps cross-project navigation usable", async ({ page }, info) => {
    const fixture = await seedCrossProjectFixture(page, info);
    await goHome(page);
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("toolbar-project-name")).toHaveCount(0);

    // A failed selector wait leaves openProjectPage on Home. Its next bounded
    // attempt must reuse that page instead of waiting for a page-only toolbar.
    await goHome(page);
    await openProjectPage(page, fixture, "destination");
    await expect(page).toHaveURL(new RegExp(
        `/${encodeURIComponent(fixture.destinationProject)}/${encodeURIComponent(fixture.destinationPage)}$`,
    ));
    await page.waitForFunction(
        id => (globalThis as any).__YJS_STORE__?.currentProjectId === id,
        fixture.destinationProjectId,
    );
});
