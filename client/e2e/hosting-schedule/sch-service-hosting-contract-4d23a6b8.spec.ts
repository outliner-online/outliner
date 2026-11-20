import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
    closeScheduleFixtures,
    removeScheduleFixture,
    scheduleCollection,
    scheduleState,
} from "../fixtures/schedule-hosting-state";
import type { scheduleContract } from "../fixtures/schedule-service-hosting/entry";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";

registerCoverageHooks();
type Fixture = typeof scheduleContract;
const payload = { strategy: "one_shot", nextRunAt: Date.now() + 86400000, params: { private: true } };
let pageId: string;
test.beforeEach(async ({ page }) => {
    pageId = `private-service-${randomUUID()}`;
    await page.goto("/");
    await page.waitForFunction(() => !!(globalThis as unknown as { scheduleContract?: Fixture; }).scheduleContract);
    await page.evaluate(() => (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract.login());
});
test.afterEach(async () => {
    if (pageId) await removeScheduleFixture(pageId);
});
test.afterAll(closeScheduleFixtures);

test("real service crosses all five Hosting routes and preserves read-only state", async ({ page }) => {
    const requests: { path: string; method: string; keys: string[]; credential: boolean; }[] = [];
    page.on("request", request => {
        if (!new URL(request.url()).pathname.startsWith("/api/")) return;
        const body = request.postDataJSON();
        requests.push({
            path: new URL(request.url()).pathname,
            method: request.method(),
            keys: Object.keys(body).sort(),
            credential: typeof body.idToken === "string" && body.idToken.length > 0,
        });
        expect(new URL(request.url()).search).toBe("");
        expect(request.headers()["content-type"]).toContain("application/json");
        expect(body.pageId).toBe(pageId);
    });
    const created = await page.evaluate(
        ({ pageId, payload }) =>
            (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract.createSchedule(pageId, payload),
        { pageId, payload },
    );
    expect(typeof created.scheduleId).toBe("string");
    const ref = scheduleCollection(pageId).doc(created.scheduleId);
    expect((await ref.get()).data().params).toEqual(payload.params);
    const beforeRead = await scheduleState(pageId);
    const list = await page.evaluate(
        id => (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract.listSchedules(id),
        pageId,
    );
    expect(list.map(entry => entry.id)).toContain(created.scheduleId);
    const calendar = await page.evaluate(
        id => (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract.exportCalendar(id),
        pageId,
    );
    expect(calendar.text).toContain("BEGIN:VCALENDAR");
    expect(calendar.filename).toBe(`outliner-schedules-${pageId}.ics`);
    expect(await scheduleState(pageId)).toEqual(beforeRead);
    const updated = { ...payload, nextRunAt: payload.nextRunAt + 60000 };
    expect(
        await page.evaluate(
            ({ pageId, id, updated }) =>
                (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract.updateSchedule(pageId, id,
                    updated),
            { pageId, id: created.scheduleId, updated },
        ),
    ).toEqual({ success: true });
    expect((await ref.get()).data().nextRunAt).toBe(updated.nextRunAt);
    expect(
        await page.evaluate(
            ({ pageId, id }) =>
                (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract.cancelSchedule(pageId, id),
            { pageId, id: created.scheduleId },
        ),
    ).toEqual({ success: true });
    expect((await ref.get()).exists).toBe(false);
    expect(requests.map(entry => entry.path)).toEqual(["/api/create-schedule", "/api/list-schedules",
        "/api/export-schedules-ical", "/api/update-schedule", "/api/cancel-schedule"]);
    expect(requests.every(entry => entry.method === "POST" && entry.credential)).toBe(true);
    expect(requests.map(entry => entry.keys)).toEqual([
        ["idToken", "pageId", "schedule"],
        ["idToken", "pageId"],
        ["idToken", "pageId"],
        ["idToken", "pageId", "schedule", "scheduleId"],
        ["idToken", "pageId", "scheduleId"],
    ]);
});

for (const variant of ["invalid", "html", "unavailable"] as const) {
    test(`${variant} cannot pass any service operation`, async ({ page }) => {
        await scheduleCollection(pageId).doc("retained").set({
            ...payload,
            executedAt: null,
            createdBy: "private-fixture",
        });
        const before = await scheduleState(pageId);
        await page.route("**/api/**", async route => {
            if (variant === "unavailable") {
                await route.abort("connectionrefused");
            } else if (variant === "invalid") {
                const body = route.request().postDataJSON();
                await route.continue({ postData: JSON.stringify({ ...body, idToken: "not-a-firebase-id-token" }) });
            } else {
                // Real Hosting bytes/errors, never a fulfilled success response.
                await route.continue({
                    url: `http://127.0.0.1:57100/${variant === "html" ? "index.html" : "api/unavailable"}`,
                    method: variant === "html" ? "GET" : "POST",
                    postData: undefined,
                });
            }
        });
        for (const operation of ["create", "list", "update", "cancel", "export"] as const) {
            const response = variant === "unavailable"
                ? undefined
                : page.waitForResponse(res =>
                    res.request().resourceType() === "fetch" && new URL(res.url()).origin === "http://127.0.0.1:57100"
                );
            const failed = await page.evaluate(async ({ pageId, payload, operation }) => {
                const service = (globalThis as unknown as { scheduleContract: Fixture; }).scheduleContract;
                try {
                    if (operation === "create") await service.createSchedule(pageId, payload);
                    if (operation === "list") await service.listSchedules(pageId);
                    if (operation === "update") await service.updateSchedule(pageId, "retained", payload);
                    if (operation === "cancel") await service.cancelSchedule(pageId, "retained");
                    if (operation === "export") await service.exportCalendar(pageId);
                    return false;
                } catch {
                    return true;
                }
            }, { pageId, payload, operation });
            const received = response ? await response : undefined;
            if (received) {
                expect(received.status()).toBe(variant === "invalid" ? 401 : variant === "html" ? 200 : 404);
                expect(received.headers()["content-type"]).toContain(
                    variant === "html" ? "text/html" : variant === "invalid" ? "application/json" : "text/html",
                );
            }
            expect(failed).toBe(true);
            expect(await scheduleState(pageId)).toEqual(before);
        }
    });
}
