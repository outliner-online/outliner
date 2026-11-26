import { beforeAll, describe, expect, test } from "vitest";
import {
    activateNotification,
    buildPushWorker,
    type CapturedProducerDelivery,
    captureProductionMobileDelivery,
    deliverPush,
    deliverPushData,
    enrollCurrentDevice,
    holdClientDiscovery,
    installPushBrowserPage,
    instrumentPushWorker,
    loginAccount,
    loginAndEnroll,
    observations,
    openNotificationSettings,
    pushPayload,
    readBrowserBinding,
    releaseClientDiscovery,
    restartPushWorker,
    startPushBrowser,
} from "./helpers/web-push-browser.fixture";

/** @feature ENV-6d92e174
 * Actual production app enrollment/worker; provider push and notification activation are controlled browser boundaries.
 */
describe("production-built Web Push worker", () => {
    beforeAll(buildPushWorker, 900_000);

    test("visible pushes respect durable logout, account switch and worker restart despite failed cleanup",
        async () => {
            const fixture = await startPushBrowser();
            try {
                const generationA = await loginAndEnroll(fixture, "worker-a@example.test");
                let worker = await instrumentPushWorker(fixture);
                const payloadA = pushPayload(generationA);
                await deliverPush(fixture, worker, payloadA);
                expect((await observations(worker)).shown).toEqual(["Grid changed"]);
                const displayed = await worker.evaluate(async () => {
                    const notifications = await (globalThis as unknown as ServiceWorkerGlobalScope).registration
                        .getNotifications();
                    return notifications.map(notification => ({
                        title: notification.title,
                        body: notification.body,
                        data: notification.data,
                    }));
                });
                expect(displayed).toEqual([{
                    title: payloadA.title,
                    body: `${payloadA.body}\nObserved ${payloadA.observedAt}`,
                    data: payloadA,
                }]);
                await deliverPush(fixture, worker, { ...payloadA, href: "https://outside.example/" });
                expect((await observations(worker)).shown).toHaveLength(1);

                fixture.cleanupFails = true;
                await fixture.page.evaluate(() => localStorage.setItem("fixture:cleanup-failure", "true"));
                await fixture.page.goto(`${fixture.base}/projects/new`);
                await fixture.page.locator("button.logout-btn").click();
                await expect.poll(() => fixture.page.locator(".email-login-form").isVisible()).toBe(true);
                expect((await readBrowserBinding(fixture.page)).generation).toBeUndefined();
                await deliverPush(fixture, worker, payloadA);
                await activateNotification(worker, payloadA.ruleId);
                expect((await observations(worker)).shown).toHaveLength(1);
                expect((await observations(worker)).operations).toEqual([]);
                expect(
                    await worker.evaluate(async () =>
                        (await (globalThis as unknown as ServiceWorkerGlobalScope).registration.getNotifications())
                            .length
                    ),
                ).toBe(0);

                await loginAccount(fixture, "worker-b@example.test");
                await deliverPush(fixture, worker, payloadA);
                expect((await observations(worker)).shown).toHaveLength(1);
                // The browser later removes the old subscription; its already captured A delivery remains available.
                fixture.cleanupFails = false;
                await fixture.page.evaluate(() => {
                    localStorage.removeItem("fixture:cleanup-failure");
                    localStorage.removeItem("fixture:subscription");
                });
                const generationB = await enrollCurrentDevice(fixture);
                expect(generationB).not.toBe(generationA);
                const payloadB = pushPayload(generationB, "current-b-rule");
                await deliverPush(fixture, worker, payloadB);
                expect((await observations(worker)).shown).toHaveLength(2);
                await fixture.page.goto("about:blank");
                await restartPushWorker(fixture);
                worker = await instrumentPushWorker(fixture);
                expect(
                    await worker.evaluate(async () =>
                        (await (globalThis as unknown as ServiceWorkerGlobalScope).clients.matchAll({ type: "window" }))
                            .length
                    ),
                )
                    .toBe(0);
                await deliverPush(fixture, worker, payloadA);
                expect((await observations(worker)).shown).toEqual([]);
                await deliverPush(fixture, worker, payloadB);
                expect((await observations(worker)).shown).toEqual(["Grid changed"]);
                await activateNotification(worker, payloadB.ruleId);
                expect((await observations(worker)).operations).toEqual([`open:${fixture.base}${payloadB.href}`]);
                // Synthetic notification activation has no trusted OS interaction token. The actual browser
                // openWindow call is still made; this boundary does not claim a successful native background tap.
                expect((await observations(worker)).openFailures).toEqual(["InvalidAccessError"]);
            } finally {
                await fixture.close();
            }
        }, 180_000);

    test(
        "encrypted Grid/Calendar/Kanban deliveries open saved contexts and disarm during discovery prevents navigation",
        async () => {
            const fixture = await startPushBrowser();
            try {
                const generation = await loginAndEnroll(fixture, "worker-tap@example.test");
                const worker = await instrumentPushWorker(fixture);
                let held: CapturedProducerDelivery | undefined;
                for (const kind of ["grid", "calendar", "kanban"] as const) {
                    const captured = await captureProductionMobileDelivery(kind, generation);
                    const { payload, rule } = captured;
                    if (kind === "grid") held = captured;
                    expect(captured.capture).toMatchObject({ requestCount: 1, vapidVerified: true, accepted: true });
                    expect(captured.capture.encryptedBytes).toBeGreaterThan(Buffer.byteLength(captured.plaintext));
                    expect(payload.enrollmentGeneration).toBe(generation);
                    expect(payload.ruleId).toBe(rule.ruleId);
                    expect(payload.target).toEqual(rule.target);
                    expect(rule.target.kind).toBe(kind);
                    const destination = new URL(payload.href, fixture.base);
                    expect(destination.origin).toBe(fixture.base);
                    expect(destination.pathname).toBe(
                        `/${encodeURIComponent(rule.target.projectId)}/-/${kind}s/${
                            encodeURIComponent(rule.target.objectId)
                        }`,
                    );
                    expect(destination.hash).toBe("");
                    // Expected context comes from the committed rule, independently of the captured payload/href.
                    if (kind === "kanban") {
                        expect(Object.fromEntries(destination.searchParams)).toEqual({ ...rule.context, version: "1" });
                    } else {
                        const key = kind === "grid" ? "observation" : "context";
                        expect([...destination.searchParams.keys()]).toEqual([key]);
                        expect(JSON.parse(destination.searchParams.get(key)!)).toEqual(rule.context);
                    }
                    expect(rule.context).toMatchObject({
                        locale: kind === "calendar" ? "ja-JP" : "en-GB",
                        timeZone: "Asia/Tokyo",
                        ...(kind === "calendar" ? { viewType: "month", monthLaneFilter: "todo" } : {}),
                    });
                    const before = (await observations(worker)).operations.length;
                    await deliverPushData(fixture, worker, captured.plaintext);
                    const displayed = await worker.evaluate(async tag => {
                        const notifications = await (globalThis as unknown as ServiceWorkerGlobalScope).registration
                            .getNotifications({ tag });
                        return notifications.map(notification => ({
                            title: notification.title,
                            body: notification.body,
                            data: notification.data,
                        }));
                    }, rule.ruleId);
                    expect(displayed).toEqual([{
                        title: payload.title,
                        body: `${payload.body}\nObserved ${payload.observedAt}`,
                        data: payload,
                    }]);
                    await activateNotification(worker, rule.ruleId);
                    await expect.poll(() => fixture.page.url()).toBe(`${fixture.base}${payload.href}`);
                    expect((await observations(worker)).operations[before]).toBe(
                        `navigate:${fixture.base}${payload.href}`,
                    );
                    const label = { grid: "Grids", calendar: "Calendars", kanban: "Kanbans" }[kind];
                    await expect.poll(() =>
                        fixture.page.getByRole("navigation", { name: "Breadcrumb" })
                            .getByRole("link", { name: label, exact: true }).isVisible()
                    ).toBe(true);
                }
                await openNotificationSettings(fixture);
                expect(held).toBeDefined();
                await deliverPushData(fixture, worker, held!.plaintext);
                const prior = (await observations(worker)).operations.length;
                await holdClientDiscovery(worker);
                await activateNotification(worker, held!.rule.ruleId, false);
                await expect.poll(() =>
                    worker.evaluate(() =>
                        (self as unknown as { observations: { discoveryReached: boolean; }; }).observations
                            .discoveryReached
                    )
                ).toBe(true);
                await fixture.page.getByRole("button", { name: "Disable notifications" }).click();
                await expect.poll(() => fixture.page.getByTestId("push-status").textContent()).toContain("disabled");
                expect((await readBrowserBinding(fixture.page)).generation).toBeUndefined();
                await releaseClientDiscovery(worker);
                expect((await observations(worker)).operations).toHaveLength(prior);
                expect(fixture.page.url()).toBe(`${fixture.base}/settings`);
            } finally {
                await fixture.close();
            }
        },
        180_000,
    );

    test("failed local disarm does not acknowledge disable or claim suppression after a worker restart", async () => {
        const fixture = await startPushBrowser();
        try {
            const generation = await loginAndEnroll(fixture, "worker-failed-disarm@example.test");
            fixture.cleanupFails = true;
            const failLocalWrites = () => {
                localStorage.setItem("fixture:cleanup-failure", "true");
                const original = IDBObjectStore.prototype.put;
                IDBObjectStore.prototype.put = function(...args) {
                    if (this.name === "enrollment" && this.transaction.db.name === "outliner-web-push") {
                        throw new DOMException("Controlled local write failure", "QuotaExceededError");
                    }
                    return original.apply(this, args);
                };
            };
            await fixture.page.addInitScript(failLocalWrites);
            await fixture.page.evaluate(failLocalWrites);
            await fixture.page.getByRole("button", { name: "Disable notifications" }).click();
            await expect.poll(() => fixture.page.getByTestId("push-status").textContent()).toContain("incomplete");
            expect((await readBrowserBinding(fixture.page)).generation).toBe(generation);
            await fixture.page.goto(`${fixture.base}/projects/new`);
            await fixture.page.locator("button.logout-btn").click();
            await expect.poll(() => fixture.page.locator(".auth-container .error").textContent()).toContain(
                "Could not verify local disarm",
            );
            expect(await fixture.page.locator(".email-login-form").isVisible()).toBe(false);
            await fixture.page.goto("about:blank");
            await restartPushWorker(fixture);
            const worker = await instrumentPushWorker(fixture);
            expect(
                await worker.evaluate(async () =>
                    (await (globalThis as unknown as ServiceWorkerGlobalScope).clients.matchAll({ type: "window" }))
                        .length
                ),
            ).toBe(0);
            await deliverPush(fixture, worker, pushPayload(generation));
            expect((await observations(worker)).shown).toEqual(["Grid changed"]);
        } finally {
            await fixture.close();
        }
    }, 180_000);

    test("a retained A enrollment continuation cannot overwrite a newer B binding in another tab", async () => {
        const fixture = await startPushBrowser();
        let release!: () => void;
        try {
            await loginAccount(fixture, "worker-delayed-a@example.test");
            await openNotificationSettings(fixture);
            let started!: (generation: string) => void;
            const committed = new Promise<string>(resolve => started = resolve);
            fixture.registrationDelay = { started, release: new Promise<void>(resolve => release = resolve) };
            await fixture.page.getByRole("button", { name: "Enable notifications" }).click();
            const generationA = await committed;

            const pageB = await fixture.context.newPage();
            await installPushBrowserPage(pageB);
            await pageB.goto(`${fixture.base}/projects/new`);
            await pageB.locator("button.logout-btn").click();
            await expect.poll(() => pageB.locator(".email-login-form").isVisible()).toBe(true);
            const second = { ...fixture, page: pageB };
            await loginAccount(second, "worker-delayed-b@example.test", false);
            const generationB = await enrollCurrentDevice(second);
            const compensation = fixture.page.waitForResponse(response =>
                response.url().endsWith("/disable") && response.request().method() === "POST"
            );
            release();
            await compensation;
            expect((await readBrowserBinding(pageB)).generation).toBe(generationB);
            const worker = await instrumentPushWorker(fixture);
            await deliverPush(fixture, worker, pushPayload(generationA));
            expect((await observations(worker)).shown).toEqual([]);
            await deliverPush(fixture, worker, pushPayload(generationB));
            expect((await observations(worker)).shown).toEqual(["Grid changed"]);
        } finally {
            release?.();
            await fixture.close();
        }
    }, 180_000);
});
