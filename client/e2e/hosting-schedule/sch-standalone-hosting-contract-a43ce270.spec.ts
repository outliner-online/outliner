import type { Response } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
    closeScheduleFixtures,
    removeScheduleFixture,
    scheduleCollection,
    scheduleState,
} from "../fixtures/schedule-hosting-state";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";

registerCoverageHooks();
let pageId: string;
let uid: string;
async function successfulRead(response: Response) {
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const data = await response.json();
    expect(Array.isArray(data.schedules)).toBe(true);
    return data.schedules;
}
test.beforeEach(async ({ page }) => {
    pageId = `private-page-${randomUUID()}`;
    await page.goto("/");
    await page.waitForFunction(() =>
        typeof (globalThis as unknown as { scheduleLogin?: unknown; }).scheduleLogin === "function"
    );
    uid = await page.evaluate(() => (globalThis as unknown as { scheduleLogin(): Promise<string>; }).scheduleLogin());
});
test.afterEach(async () => {
    if (pageId) await removeScheduleFixture(pageId);
});
test.afterAll(closeScheduleFixtures);

for (const empty of [false, true]) {
    test(`restored SDK session reads and renders ${empty ? "empty" : "known"} actual schedules without writes`, async ({ page }) => {
        if (!empty) {
            await scheduleCollection(pageId).doc("known").set({
                strategy: "Private one-shot",
                cadence: "once",
                nextRunAt: Date.now() + 86400000,
                executedAt: null,
                createdBy: uid,
            });
        }
        const before = await scheduleState(pageId);
        const response = page.waitForResponse("**/api/list-schedules");
        // A real static reload must restore the SDK session before the page reads.
        await page.goto(`/schedule?pageId=${pageId}`);
        const received = await response;
        const request = received.request();
        expect(request.method()).toBe("POST");
        expect(new URL(request.url()).search).toBe("");
        const body = request.postDataJSON();
        const bearer = await request.headerValue("authorization");
        expect(body.pageId).toBe(pageId);
        expect(typeof body.idToken === "string" && body.idToken.length > 0 && bearer === `Bearer ${body.idToken}`).toBe(
            true,
        );
        expect(request.headers()["content-type"]).toContain("application/json");
        expect((await successfulRead(received)).length).toBe(empty ? 0 : 1);
        await expect(page.locator("tbody tr")).toHaveCount(empty ? 0 : 1);
        if (!empty) await expect(page.locator('[data-schedule-id="known"] td').first()).toHaveText("Private one-shot");
        expect(await scheduleState(pageId)).toEqual(before);
    });
}

for (const variant of ["missing", "invalid", "html"]) {
    test(`${variant} cannot masquerade as an authenticated empty read`, async ({ page }) => {
        await scheduleCollection(pageId).doc("retained").set({
            strategy: "Private one-shot",
            nextRunAt: Date.now() + 86400000,
            executedAt: null,
            createdBy: uid,
        });
        const before = await scheduleState(pageId);
        await page.route("**/api/list-schedules", async route => {
            const body = route.request().postDataJSON();
            if (variant === "html") {
                await route.continue({ url: "http://127.0.0.1:57100/index.html", method: "GET", postData: undefined });
            } else {
                if (variant === "missing") delete body.idToken;
                else body.idToken = "not-a-firebase-id-token";
                await route.continue({ postData: JSON.stringify(body) });
            }
        });
        const response = page.waitForResponse(res =>
            res.request().resourceType() === "fetch" && new URL(res.url()).origin === "http://127.0.0.1:57100"
        );
        await page.goto(`/schedule?pageId=${pageId}`);
        const received = await response;
        expect(received.status()).toBe(variant === "missing" ? 400 : variant === "invalid" ? 401 : 200);
        await expect(successfulRead(received)).rejects.toThrow();
        if (variant !== "html") {
            expect(await received.json()).toEqual({
                error: variant === "missing" ? "Invalid request" : "Authentication failed",
            });
        } else expect(received.headers()["content-type"]).toContain("text/html");
        await expect(page.locator("tbody tr")).toHaveCount(0);
        expect(await scheduleState(pageId)).toEqual(before);
    });
}
