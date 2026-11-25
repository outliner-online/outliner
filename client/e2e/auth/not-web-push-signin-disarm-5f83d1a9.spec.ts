import { expect, test } from "@playwright/test";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { TestHelpers } from "../utils/testHelpers";

registerCoverageHooks();

test("signed-in reuse durably disarms the previous Web Push generation before Firebase sign-in", async ({
    page,
}, testInfo) => {
    await TestHelpers.seedProjectAndNavigateForProject(page, testInfo);
    await page.evaluate(async () =>
        new Promise<void>((resolve, reject) => {
            localStorage.removeItem("outliner:web-push-armed");
            const open = indexedDB.open("outliner-web-push", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("enrollment");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const tx = open.result.transaction("enrollment", "readwrite");
                tx.objectStore("enrollment").put({
                    fence: 21,
                    generation: "prior_signin_generation",
                    vapidKeyId: "key-1",
                }, "current");
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            };
        })
    );

    await page.evaluate(async () => {
        const manager = (globalThis as typeof globalThis & {
            __USER_MANAGER__?: { loginWithEmailPassword(email: string, password: string): Promise<void>; };
        }).__USER_MANAGER__;
        if (!manager) throw new Error("UserManager is unavailable");
        await manager.loginWithEmailPassword("test@example.com", "password");
    });

    const binding = await page.evaluate(async () =>
        new Promise<{ fence: number; generation?: string; }>((resolve, reject) => {
            const open = indexedDB.open("outliner-web-push", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const read = open.result.transaction("enrollment", "readonly").objectStore("enrollment").get("current");
                read.onsuccess = () => resolve(read.result);
                read.onerror = () => reject(read.error);
            };
        })
    );
    expect(binding).toEqual({ fence: 22 });
});

test("signed-in reuse stops before Firebase sign-in when durable disarm cannot be verified", async ({
    page,
}, testInfo) => {
    await TestHelpers.seedProjectAndNavigateForProject(page, testInfo);
    const originalUid = await page.evaluate(() =>
        (globalThis as typeof globalThis & { __USER_MANAGER__?: { auth: { currentUser?: { uid: string; }; }; }; })
            .__USER_MANAGER__?.auth.currentUser?.uid
    );
    await page.evaluate(async () =>
        new Promise<void>((resolve, reject) => {
            const open = indexedDB.open("outliner-web-push", 2);
            open.onupgradeneeded = () => {
                const store = open.result.objectStoreNames.contains("enrollment")
                    ? open.transaction!.objectStore("enrollment")
                    : open.result.createObjectStore("enrollment");
                store.put({ fence: 31, generation: "blocked_signin_generation", vapidKeyId: "key-1" }, "current");
            };
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                open.result.close();
                resolve();
            };
        })
    );

    const result = await page.evaluate(async () => {
        const manager = (globalThis as typeof globalThis & {
            __USER_MANAGER__?: {
                auth: { currentUser?: { uid: string; }; };
                loginWithEmailPassword(email: string, password: string): Promise<void>;
            };
        }).__USER_MANAGER__;
        if (!manager) throw new Error("UserManager is unavailable");
        try {
            await manager.loginWithEmailPassword("test@example.com", "password");
            return { error: "", uid: manager.auth.currentUser?.uid };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
                uid: manager.auth.currentUser?.uid,
            };
        }
    });
    expect(result).toEqual({ error: "Could not verify local disarm", uid: originalUid });
});
