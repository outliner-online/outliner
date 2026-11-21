import { expect, test } from "@playwright/test";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { TestHelpers } from "../utils/testHelpers";
registerCoverageHooks();
// E2E: Login status indicator menu → Sign out
// Keep this spec small and deterministic per project guidance.

test("opens user menu and signs out from toolbar indicator", async ({ page }, testInfo) => {
    // Prepare minimal environment and navigate to home (toolbar is global)
    await TestHelpers.seedProjectAndNavigateForProject(page, testInfo);

    const indicator = page.getByTestId("login-status-indicator");
    await expect(indicator).toBeVisible();

    // Ensure authenticated; use UserManager directly since dev-login UI is not on home page
    const status = (await indicator.getAttribute("data-status")) || "";
    if (status !== "authenticated") {
        // Use UserManager directly to authenticate
        await page.evaluate(async () => {
            // Wait for UserManager to be available
            let attempts = 0;
            while (attempts < 50) {
                const mgr = (globalThis as any).__USER_MANAGER__;
                if (mgr?.loginWithEmailPassword) {
                    await mgr.loginWithEmailPassword("test@example.com", "password");
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            throw new Error("UserManager not available after waiting");
        });

        // Wait for toolbar indicator to reflect authenticated state
        await expect(indicator).toHaveAttribute("data-status", "authenticated", { timeout: 20000 });
    }

    // Seed the same browser-wide binding read by Settings and the production
    // worker, deliberately without the convenience localStorage hint. Logout
    // must still advance and clear this durable authority.
    const armedFence = await page.evaluate(async () => {
        localStorage.removeItem("outliner:web-push-armed");
        return new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("outliner-web-push", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("enrollment");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const tx = open.result.transaction("enrollment", "readwrite");
                tx.objectStore("enrollment").put({
                    fence: 7,
                    generation: "logout_generation_0001",
                    vapidKeyId: "key-1",
                }, "current");
                tx.oncomplete = () => {
                    open.result.close();
                    resolve(7);
                };
                tx.onerror = () => reject(tx.error);
            };
        });
    });

    // 1) Click the indicator to open the dropdown menu
    await indicator.click();
    const menu = page.getByTestId("user-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Sign out");

    // 2) Click Sign out → should log out and close menu
    const signOut = page.getByTestId("user-menu-signout");
    await expect(signOut).toBeVisible();
    await signOut.click();

    await expect(indicator).toHaveAttribute("data-status", "unauthenticated", { timeout: 20000 });
    await expect(menu).toBeHidden({ timeout: 10000 });

    await page.reload();
    const bindingAfterRestart = await page.evaluate(async () =>
        new Promise<{ fence: number; generation?: string; }>((resolve, reject) => {
            const open = indexedDB.open("outliner-web-push", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const tx = open.result.transaction("enrollment", "readonly");
                const read = tx.objectStore("enrollment").get("current");
                read.onsuccess = () => resolve(read.result);
                read.onerror = () => reject(read.error);
            };
        })
    );
    expect(bindingAfterRestart).toEqual({ fence: armedFence + 1 });
    expect(await page.evaluate(() => localStorage.getItem("outliner:web-push-armed"))).toBeNull();
});
