/// <reference lib="webworker" />

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { Browser, BrowserContext, CDPSession, Page, Worker } from "../../../client/node_modules/@playwright/test";
import type { MobilePayloadV1 } from "../../../shared/src/notifications/mobile-payload";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const client = path.join(root, "client");
const build = path.join(root, "build");
const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".json": "application/json",
};

export function buildPushWorker(): void {
    if (process.env.WEB_PUSH_USE_EXISTING_BUILD !== "1") {
        const env = { ...process.env };
        delete env.NODE_ENV;
        const result = spawnSync("npm", ["run", "build:production"], {
            cwd: client,
            env,
            encoding: "utf8",
            timeout: 900_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
    expect(fs.existsSync(path.join(build, "service-worker.js"))).toBe(true);
}

function fixtureToken(email: string): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    return `${encode({ alg: "none", typ: "JWT" })}.${
        encode({
            aud: "outliner-d57b0",
            auth_time: now,
            email,
            exp: now + 3600,
            firebase: { sign_in_provider: "password" },
            iat: now,
            iss: "https://securetoken.google.com/outliner-d57b0",
            sub: email,
            user_id: email,
        })
    }.fixture`;
}
function tokenPayload(token: string): { email?: string; } {
    try {
        return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    } catch {
        return {};
    }
}
export async function installPushBrowserPage(page: Page): Promise<void> {
    await page.route("https://identitytoolkit.googleapis.com/**", async route => {
        const request = route.request().postDataJSON() as { email?: string; idToken?: string; };
        const email = request.email ?? tokenPayload(request.idToken ?? "").email;
        const lookup = new URL(route.request().url()).pathname.endsWith("accounts:lookup");
        if (!email) {
            await route.fulfill({ status: 400, body: '{"error":{"message":"INVALID_ID_TOKEN"}}' });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
                lookup
                    ? {
                        users: [{
                            email,
                            localId: email,
                            emailVerified: true,
                            providerUserInfo: [],
                            createdAt: "1700000000000",
                            lastLoginAt: "1700000000000",
                        }],
                    }
                    : {
                        email,
                        localId: email,
                        idToken: fixtureToken(email),
                        refreshToken: `fixture-${email}`,
                        expiresIn: "3600",
                        registered: true,
                    },
            ),
        });
    });
    await page.addInitScript(() => {
        Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
            configurable: true,
            get: () => {
                const subscription = (options: PushSubscriptionOptionsInit) => ({
                    endpoint: "https://push.example.test/built-worker",
                    options,
                    toJSON: () => ({
                        endpoint: "https://push.example.test/built-worker",
                        keys: { p256dh: "fixture-p256dh", auth: "fixture-auth" },
                    }),
                    unsubscribe: async () => {
                        if (localStorage.getItem("fixture:cleanup-failure")) {
                            throw new Error("Controlled browser cleanup failure");
                        }
                        localStorage.removeItem("fixture:subscription");
                        return true;
                    },
                });
                return {
                    getSubscription: async () =>
                        localStorage.getItem("fixture:subscription")
                            ? subscription({
                                applicationServerKey: Uint8Array.from([4, ...new Array(64).fill(1)]).buffer,
                            })
                            : undefined,
                    subscribe: async (options: PushSubscriptionOptionsInit) => {
                        localStorage.setItem("fixture:subscription", "true");
                        return subscription(options);
                    },
                };
            },
        });
    });
}

export interface PushBrowserFixture {
    base: string;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    cdp: CDPSession;
    registrationId: string;
    workerVersion(): { versionId: string; runningStatus: string; } | undefined;
    cleanupFails: boolean;
    registrationDelay?: { started(generation: string): void; release: Promise<void>; };
    close(): Promise<void>;
}

export async function startPushBrowser(): Promise<PushBrowserFixture> {
    const registrations = new Map<string, Record<string, unknown>>();
    let fixture: PushBrowserFixture;
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const uid = tokenPayload(req.headers.authorization?.replace(/^Bearer /u, "") ?? "").email ?? "";
        const json = (status: number, body: object) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (pathname === "/api/deployment") {
            json(200, { deploymentMode: "cloud" });
            return;
        }
        if (pathname === "/api/notifications/push/config") {
            json(200, {
                available: true,
                publicKey: Buffer.from([4, ...new Array(64).fill(1)]).toString("base64url"),
                vapidKeyId: "built-worker-key",
            });
            return;
        }
        if (pathname === "/api/notifications/push/admissions") {
            json(200, { admissionFence: 1 });
            return;
        }
        const match = pathname.match(/^\/api\/notifications\/push\/devices\/([^/]+)(\/disable)?$/u);
        if (match) {
            const key = JSON.stringify([uid, match[1]]);
            const old = registrations.get(key) ?? { deviceId: match[1], revision: 0, state: "disabled" };
            if (req.method === "GET") {
                json(200, old);
                return;
            }
            if (match[2]) {
                if (fixture.cleanupFails) {
                    json(503, { error: "controlled_cleanup_failure" });
                    return;
                }
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    const authority = body
                        ? JSON.parse(body) as { expectedRevision?: number; enrollmentGeneration?: string; }
                        : undefined;
                    if (
                        authority?.expectedRevision !== undefined
                        && (authority.expectedRevision !== old.revision
                            || authority.enrollmentGeneration !== old.enrollmentGeneration)
                    ) {
                        json(200, old);
                        return;
                    }
                    const status = {
                        ...old,
                        state: "disabled",
                        revision: Number(old.revision) + 1,
                        enrollmentGeneration: undefined,
                    };
                    registrations.set(key, status);
                    json(200, status);
                });
                return;
            }
            let body = "";
            req.on("data", chunk => body += chunk);
            req.on("end", async () => {
                const value = JSON.parse(body) as {
                    enrollmentGeneration: string;
                    subscription: { endpoint: string; };
                };
                const status = {
                    deviceId: match[1],
                    revision: Number(old.revision) + 1,
                    state: "registered",
                    vapidKeyId: "built-worker-key",
                    endpointHash: createHash("sha256").update(value.subscription.endpoint).digest("hex"),
                    enrollmentGeneration: value.enrollmentGeneration,
                };
                registrations.set(key, status);
                const delayed = fixture.registrationDelay;
                if (delayed) {
                    fixture.registrationDelay = undefined;
                    delayed.started(value.enrollmentGeneration);
                    await delayed.release;
                }
                json(200, status);
            });
            return;
        }
        if (pathname.startsWith("/api/")) {
            json(404, { error: "unavailable_fixture_resource" });
            return;
        }
        let filename = path.join(build, decodeURIComponent(pathname));
        if (!filename.startsWith(build) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
            filename = path.join(build, "index.html");
        }
        res.writeHead(200, { "content-type": mime[path.extname(filename)] ?? "application/octet-stream" });
        fs.createReadStream(filename).pipe(res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { chromium } = createRequire(path.join(client, "package.json"))(
        "@playwright/test",
    ) as typeof import("../../../client/node_modules/@playwright/test");
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const browser = await chromium.launch({ args: ["--no-sandbox"], ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ permissions: ["notifications"] });
    // Production keeps its configured API origin. Only the external HTTP boundary is redirected into this fixture.
    await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/notifications/push/")) {
            const response = await context.request.fetch(`${base}${url.pathname}${url.search}`, {
                method: request.method(),
                headers: {
                    authorization: request.headers().authorization ?? "",
                    "content-type": "application/json",
                },
                data: request.postData() ?? undefined,
            });
            await route.fulfill({
                response,
                headers: {
                    ...response.headers(),
                    "access-control-allow-origin": base,
                    "access-control-allow-headers": "authorization,content-type",
                    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
                },
            });
        } else if (url.origin === base) await route.continue();
        else await route.fulfill({ status: 503, body: '{"error":"external_fixture_resource_unavailable"}' });
    });
    await context.routeWebSocket("**", socket => socket.close());
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const recordError = (message: string) => {
        pageErrors.push(message.slice(0, 1000));
        if (pageErrors.length > 8) pageErrors.shift();
    };
    page.on("pageerror", error => recordError(error.message));
    page.on("console", message => {
        if (message.type() === "error") recordError(message.text());
    });
    await installPushBrowserPage(page);
    const cdp = await context.newCDPSession(page);
    const registrationIds = new Map<string, string>();
    const versions = new Map<
        string,
        { versionId: string; registrationId: string; runningStatus: string; status: string; }
    >();
    cdp.on("ServiceWorker.workerErrorReported", event => recordError(event.errorMessage.errorMessage));
    cdp.on("ServiceWorker.workerVersionUpdated", event => {
        for (const version of event.versions) versions.set(version.versionId, version);
    });
    cdp.on("ServiceWorker.workerRegistrationUpdated", event => {
        for (const registration of event.registrations) {
            registrationIds.set(registration.scopeURL, registration.registrationId);
        }
    });
    await cdp.send("ServiceWorker.enable");
    fixture = {
        base,
        browser,
        context,
        page,
        cdp,
        registrationId: "",
        workerVersion: () =>
            [...versions.values()].find(version =>
                version.registrationId === fixture.registrationId && version.status === "activated"
            ),
        cleanupFails: false,
        close: async () => {
            await browser.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
    try {
        await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await expect.poll(
            () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.state),
            { timeout: 30_000 },
        ).toBe("activated");
    } catch (error) {
        await fixture.close();
        throw new Error(`Production worker startup failed: ${String(error)}; page errors: ${pageErrors.join("; ")}`);
    }
    await expect.poll(() => registrationIds.get(`${base}/`)).toBeTruthy();
    fixture.registrationId = registrationIds.get(`${base}/`)!;
    return fixture;
}

export async function loginAccount(fixture: PushBrowserFixture, email: string, navigate = true): Promise<void> {
    const { page, base } = fixture;
    if (navigate) await page.goto(`${base}/projects/new`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("isolated-password");
    await page.locator("button.email-login-btn").click();
    await expect.poll(() => page.locator("button.logout-btn").isVisible()).toBe(true);
}
export async function openNotificationSettings(fixture: PushBrowserFixture): Promise<void> {
    const { page, base } = fixture;
    if (page.url() === `${base}/settings`) return;
    await expect.poll(() => page.getByTestId("login-status-indicator").getAttribute("data-status"), {
        timeout: 10_000,
    }).toBe("authenticated");
    const settings = page.getByRole("link", { name: "Settings", exact: true });
    if (!await settings.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await settings.click();
}
export async function enrollCurrentDevice(fixture: PushBrowserFixture): Promise<string> {
    const { page } = fixture;
    await openNotificationSettings(fixture);
    await page.getByRole("button", { name: "Enable notifications" }).waitFor({ state: "visible" });
    expect(await page.getByTestId("push-status").locator("..").textContent()).not.toContain("unavailable");
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await expect.poll(() => page.getByTestId("push-status").locator("..").textContent(), { timeout: 10_000 })
        .toContain("This browser is registered.");
    const binding = await readBrowserBinding(page);
    expect(binding.generation).toBeTruthy();
    return binding.generation!;
}
export async function loginAndEnroll(fixture: PushBrowserFixture, email: string): Promise<string> {
    await loginAccount(fixture, email);
    return enrollCurrentDevice(fixture);
}

export async function readBrowserBinding(page: Page): Promise<{ fence: number; generation?: string; }> {
    return page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const channel = new MessageChannel();
        const response = new Promise<{ binding: { fence: number; generation?: string; }; }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Worker binding read timed out")), 5000);
            channel.port1.onmessage = event => {
                clearTimeout(timeout);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data);
            };
        });
        registration.active!.postMessage("outliner:read-web-push-binding", [channel.port2]);
        return (await response).binding;
    });
}

export function pushPayload(generation: string, ruleId = "built-worker-rule"): MobilePayloadV1 {
    return {
        schemaVersion: 1,
        eventId: "built-worker-event",
        ruleId,
        enrollmentGeneration: generation,
        target: { projectId: "project-one", kind: "grid", objectId: "grid-one" },
        observedAt: "2026-11-26T01:02:03.000Z",
        title: "Grid changed",
        body: "Displayed items changed: 1. Changed: Name: Visible value",
        href: `/project-one/-/grids/grid-one?${new URLSearchParams({
            observation: JSON.stringify({ version: 1, locale: "en-US", timeZone: "UTC", surface: "table" }),
        })}`,
    };
}

export interface WorkerObservations {
    shown: string[];
    operations: string[];
    openFailures: string[];
    completedPush: number;
    click?: Promise<unknown>;
    releaseDiscovery?: () => void;
    discoveryReached?: boolean;
}
interface InstrumentedWorker extends ServiceWorkerGlobalScope {
    observations: WorkerObservations;
}

export async function restartPushWorker(fixture: PushBrowserFixture): Promise<void> {
    const previous = fixture.context.serviceWorkers().find(worker =>
        worker.url() === `${fixture.base}/service-worker.js`
    );
    if (!previous) throw new Error("Expected the production worker before restart");
    const before = await inspectWorkerBinding(previous);
    const version = fixture.workerVersion();
    if (!version) throw new Error("Expected the activated production worker version");
    await fixture.cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
    await expect.poll(() => fixture.workerVersion()?.runningStatus, { timeout: 10_000 }).toBe("stopped");
    await fixture.cdp.send("ServiceWorker.startWorker", { scopeURL: `${fixture.base}/` });
    await expect.poll(() => fixture.workerVersion()?.runningStatus, { timeout: 10_000 }).toBe("running");
    // Playwright may retain the Worker wrapper while Chromium replaces its execution context.
    const restarted = fixture.context.serviceWorkers().find(worker =>
        worker.url() === `${fixture.base}/service-worker.js`
    )!;
    expect(await restarted.evaluate(() => "observations" in globalThis)).toBe(false);
    const after = await inspectWorkerBinding(restarted);
    expect(after.workerBootId).not.toBe(before.workerBootId);
    expect(after.binding).toEqual(before.binding);
}

async function inspectWorkerBinding(worker: Worker) {
    return worker.evaluate(async () => {
        const scope = globalThis as unknown as ServiceWorkerGlobalScope;
        const channel = new MessageChannel();
        const response = new Promise<{ workerBootId: string; binding: unknown; }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Worker self-inspection timed out")), 5000);
            channel.port1.onmessage = event => {
                clearTimeout(timeout);
                channel.port1.close();
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data);
            };
        });
        scope.registration.active!.postMessage("outliner:read-web-push-binding", [channel.port2]);
        return response;
    });
}

export async function instrumentPushWorker(fixture: PushBrowserFixture): Promise<Worker> {
    await expect.poll(() =>
        fixture.context.serviceWorkers().find(worker => worker.url() === `${fixture.base}/service-worker.js`)
    ).toBeTruthy();
    const worker = fixture.context.serviceWorkers().find(worker =>
        worker.url() === `${fixture.base}/service-worker.js`
    )!;
    await worker.evaluate(() => {
        const scope = globalThis as unknown as InstrumentedWorker;
        scope.observations = { shown: [], operations: [], openFailures: [], completedPush: 0 };
        const originalShow = scope.registration.showNotification.bind(scope.registration);
        scope.registration.showNotification = (title, options) => {
            scope.observations.shown.push(title);
            return originalShow(title, options);
        };
        const originalWait = ExtendableEvent.prototype.waitUntil;
        ExtendableEvent.prototype.waitUntil = function(promise) {
            return originalWait.call(this,
                this.type === "push"
                    ? Promise.resolve(promise).finally(() => scope.observations.completedPush++)
                    : promise);
        };
        const originalNavigate = WindowClient.prototype.navigate;
        WindowClient.prototype.navigate = function(url) {
            scope.observations.operations.push(`navigate:${url}`);
            return originalNavigate.call(this, url);
        };
        const originalFocus = WindowClient.prototype.focus;
        WindowClient.prototype.focus = function() {
            scope.observations.operations.push("focus");
            return originalFocus.call(this);
        };
        const originalOpen = scope.clients.openWindow.bind(scope.clients);
        scope.clients.openWindow = url => {
            scope.observations.operations.push(`open:${url}`);
            return originalOpen(url).catch(error => {
                scope.observations.openFailures.push(error.name);
                throw error;
            });
        };
    });
    return worker;
}

export async function deliverPush(fixture: PushBrowserFixture, worker: Worker, payload: unknown): Promise<void> {
    const completed = await worker.evaluate(() =>
        (globalThis as unknown as InstrumentedWorker).observations.completedPush
    );
    await fixture.cdp.send("ServiceWorker.deliverPushMessage", {
        origin: fixture.base,
        registrationId: fixture.registrationId,
        data: JSON.stringify(payload),
    });
    await expect.poll(() =>
        worker.evaluate(() => (globalThis as unknown as InstrumentedWorker).observations.completedPush)
    ).toBe(completed + 1);
}

/** Controlled native notification activation boundary; installed production listeners are unchanged. */
export async function activateNotification(worker: Worker, tag: string, wait = true): Promise<void> {
    await worker.evaluate(async tag => {
        const scope = globalThis as unknown as InstrumentedWorker;
        const [notification] = await scope.registration.getNotifications({ tag });
        if (!notification) throw new Error("Expected a real displayed browser notification");
        const event = new NotificationEvent("notificationclick", { notification });
        Object.defineProperty(event, "waitUntil", {
            value: (promise: Promise<unknown>) => {
                scope.observations.click = promise;
            },
        });
        scope.dispatchEvent(event);
    }, tag);
    if (wait) {
        await worker.evaluate(async () => {
            await (globalThis as unknown as InstrumentedWorker).observations.click;
        });
    }
}

export async function observations(worker: Worker) {
    return worker.evaluate(() => {
        const { shown, operations, openFailures, completedPush } =
            (globalThis as unknown as InstrumentedWorker).observations;
        return { shown, operations, openFailures, completedPush };
    });
}

export async function holdClientDiscovery(worker: Worker): Promise<void> {
    await worker.evaluate(() => {
        const scope = globalThis as unknown as InstrumentedWorker;
        const original = scope.clients.matchAll.bind(scope.clients);
        const held = new Promise<void>(resolve => scope.observations.releaseDiscovery = resolve);
        scope.clients.matchAll = async options => {
            scope.observations.discoveryReached = true;
            await held;
            return original(options);
        };
    });
}
export async function releaseClientDiscovery(worker: Worker): Promise<void> {
    await worker.evaluate(async () => {
        const state = (globalThis as unknown as InstrumentedWorker).observations;
        state.releaseDiscovery?.();
        await state.click;
    });
}
