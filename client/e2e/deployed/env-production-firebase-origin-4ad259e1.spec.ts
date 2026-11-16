import { expect, test } from "@playwright/test";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
registerCoverageHooks();

// Read-only availability check. No seeding or writes against the deployed site.
// TLS errors fail through playwright.deployed.config.ts; redirects cannot pass.
for (const path of ["/", "/demo/Outliner%20Basics"]) {
    test(`Hosting serves ${path} over valid HTTPS (REQ-006)`, async ({ page, baseURL }) => {
        expect(new URL(baseURL!).protocol).toBe("https:");
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        expect(response?.request().redirectedFrom()).toBeNull();
        expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
        await expect(page.locator("body")).toBeVisible();
        await expect(page.locator("body")).not.toContainText("Site Not Found");
        if (path.startsWith("/demo/")) {
            await expect(page.locator(".outliner-item").first()).toBeVisible();
        }
    });
}

test("Hosting API health returns JSON without redirect (REQ-006)", async ({ request }) => {
    const response = await request.get("/api/health", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(await response.json()).toMatchObject({ status: "OK" });
});
