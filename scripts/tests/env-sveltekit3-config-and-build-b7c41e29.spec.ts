import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import http from "http";
import { createRequire } from "module";
import type { AddressInfo } from "net";
import path from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, test } from "vitest";

/** @feature ENV-b7c41e29
 *  Title   : SvelteKit 3 configuration lives in the Vite config
 *  Source  : docs/dev-features/env-sveltekit3-config-and-build-b7c41e29.yaml
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const clientDir = path.join(repoRoot, "client");
const buildDir = path.join(repoRoot, "build");

/** Runs a client-local command (its own node_modules/.bin first on PATH). */
function runInClient(command: string, args: string[], timeout = 600_000, extraEnv: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${path.join(clientDir, "node_modules/.bin")}:${process.env.PATH}`,
        ...extraEnv,
    };
    // Vitest exports NODE_ENV=test, which would make Vite build a development
    // bundle (import.meta.env.DEV) and strip the production-only service
    // worker registration. The build under test must be the deployed one.
    if (extraEnv.NODE_ENV === undefined && "NODE_ENV" in extraEnv) delete env.NODE_ENV;
    const result = spawnSync(command, args, {
        cwd: clientDir,
        encoding: "utf-8",
        timeout,
        env,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("SvelteKit 3 configuration", () => {
    test("svelte-kit sync accepts the configuration (no legacy svelte.config.js)", () => {
        expect(fs.existsSync(path.join(clientDir, "svelte.config.js"))).toBe(false);
        const { status, output } = runInClient("svelte-kit", ["sync"], 120_000);
        expect(output).not.toContain("config_file_unsupported");
        expect(status, output).toBe(0);
    });

    // `vite` (dev server, E2E server, production build) resolves vite.config.js
    // first, while Vitest resolves vite.config.ts: both must hand SvelteKit the
    // same adapter, aliases and manual service-worker registration.
    test("both Vite configs pass the same SvelteKit options to the plugin", () => {
        const probe = `
            import { resolveConfig } from "vite";
            const out = {};
            for (const configFile of ["vite.config.js", "vite.config.ts"]) {
                const config = await resolveConfig({ configFile, mode: "production", logLevel: "silent" }, "build");
                const options = config.plugins.find(p => p.name === "vite-plugin-sveltekit-setup")?.api?.options;
                out[configFile] = {
                    adapter: options?.adapter?.name,
                    alias: options?.alias,
                    serviceWorker: options?.serviceWorker,
                    extensions: options?.extensions,
                };
            }
            console.log("PROBE" + JSON.stringify(out));
        `;
        const { status, output } = runInClient("node", ["--input-type=module", "-e", probe], 120_000);
        expect(status, output).toBe(0);
        const resolved = JSON.parse(output.slice(output.indexOf("PROBE") + 5).split("\n")[0]);
        const expected = {
            adapter: "@sveltejs/adapter-static",
            alias: { $lib: "src/lib", $stores: "src/stores", $shared: "../shared/src" },
            serviceWorker: { register: false },
            extensions: [".svelte", ".svx"],
        };
        expect(resolved["vite.config.js"]).toEqual(expected);
        expect(resolved["vite.config.ts"]).toEqual(expected);
    });

    test("ESLint loads its Svelte configuration and accepts the migrated consumers", () => {
        const { status, output } = runInClient("eslint", [
            "--max-warnings=0",
            "src/service-worker.ts",
            "src/params.ts",
            "src/hooks.server.ts",
            "src/routes/[project]/[page]/+page.svelte",
            "src/routes/[demoProject=demoProject]/-/tables/[tableId]/+page.svelte",
        ], 300_000);
        expect(status, output).toBe(0);
    });
});

describe("SvelteKit 3 production build", () => {
    let build: { status: number | null; output: string; };

    beforeAll(() => {
        fs.rmSync(buildDir, { recursive: true, force: true });
        // The command the deploy workflow runs (.github/workflows/deploy.yml).
        build = runInClient("npm", ["run", "build:production"], 900_000, { NODE_ENV: undefined });
    }, 900_000);

    test("completes and emits the SPA to the Firebase Hosting directory", () => {
        expect(build.status, build.output).toBe(0);
        const html = fs.readFileSync(path.join(buildDir, "index.html"), "utf-8");
        // index.html is the SPA fallback shell, not a prerendered page.
        expect(html).toContain("fallback");
        expect(fs.existsSync(path.join(buildDir, "_app/immutable"))).toBe(true);
        expect(fs.existsSync(path.join(buildDir, "favicon.png"))).toBe(true);
        expect(fs.existsSync(path.join(buildDir, "manifest.webmanifest"))).toBe(true);
    });

    test("builds the service worker from $app/manifest without auto-registration", () => {
        const worker = fs.readFileSync(path.join(buildDir, "service-worker.js"), "utf-8");
        expect(worker).not.toMatch(/__SVELTEKIT_MANIFEST_|__sveltekit_manifest_/);

        // Every emitted immutable entry chunk is in the precache manifest.
        const entryDir = path.join(buildDir, "_app/immutable/entry");
        const entries = fs.readdirSync(entryDir).filter(file => file.endsWith(".js"));
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(worker).toContain(`_app/immutable/entry/${entry}`);
        }
        // Static assets come along too.
        expect(worker).toContain("favicon.png");
        expect(worker).toContain("manifest.webmanifest");

        // Registration stays manual (src/routes/+layout.svelte), so SvelteKit
        // must not inject its own.
        expect(fs.readFileSync(path.join(buildDir, "index.html"), "utf-8")).not.toContain("serviceWorker");
    });
});

describe("SvelteKit 3 production service worker in a browser", () => {
    const contentTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".wasm": "application/wasm",
    };

    /** Firebase Hosting for the static output: files as-is, index.html as the SPA fallback. */
    interface DisableObservation {
        deviceId: string;
        uid?: string;
    }
    interface RegistrationObservation {
        deviceId: string;
        uid?: string;
        enrollmentGeneration: string;
    }
    interface PushRaceControl {
        registrationStarted: () => void;
        registrationFinished: () => void;
        waitForRegistrationRelease: Promise<void>;
        disabled: () => boolean;
    }

    function tokenPayload(token: string): { email?: string; user_id?: string; } {
        try {
            return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        } catch {
            return {};
        }
    }

    function serveBuild(
        disables: DisableObservation[] = [],
        registrations: RegistrationObservation[] = [],
        race?: PushRaceControl,
    ): Promise<http.Server> {
        const server = http.createServer((req, res) => {
            const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
            const token = req.headers.authorization?.match(/^Bearer (.+)$/u)?.[1] ?? "";
            const uid = tokenPayload(token).user_id;
            const json = (status: number, body: object) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(body));
            };
            if (req.method === "GET" && pathname === "/api/notifications/push/config") {
                json(200, {
                    available: true,
                    publicKey: Buffer.from([4, ...new Array<number>(64).fill(1)]).toString("base64url"),
                    vapidKeyId: "built-browser-key",
                });
                return;
            }
            const statusMatch = pathname.match(/^\/api\/notifications\/push\/devices\/([^/]+)$/u);
            if (req.method === "GET" && statusMatch) {
                json(200, { deviceId: statusMatch[1], revision: 0, state: "disabled" });
                return;
            }
            if (req.method === "POST" && pathname === "/api/notifications/push/admissions") {
                json(200, { admissionFence: 1 });
                return;
            }
            if (req.method === "PUT" && statusMatch) {
                let raw = "";
                req.on("data", chunk => raw += chunk);
                req.on("end", async () => {
                    const body = JSON.parse(raw) as {
                        enrollmentGeneration: string;
                        subscription: { endpoint: string; };
                    };
                    race?.registrationStarted();
                    if (race) await race.waitForRegistrationRelease;
                    if (race?.disabled()) {
                        json(409, { error: "conflict" });
                        race.registrationFinished();
                        return;
                    }
                    registrations.push({
                        deviceId: statusMatch[1],
                        uid,
                        enrollmentGeneration: body.enrollmentGeneration,
                    });
                    json(200, {
                        deviceId: statusMatch[1],
                        revision: 1,
                        state: "registered",
                        vapidKeyId: "built-browser-key",
                        endpointHash: createHash("sha256").update(body.subscription.endpoint).digest("hex"),
                        enrollmentGeneration: body.enrollmentGeneration,
                    });
                });
                return;
            }
            if (req.method === "POST" && /^\/api\/notifications\/push\/devices\/[^/]+\/disable$/u.test(pathname)) {
                disables.push({ deviceId: pathname.split("/").at(-2)!, uid });
                json(200, { deviceId: pathname.split("/").at(-2), revision: 2, state: "disabled" });
                return;
            }
            let file = path.join(buildDir, pathname);
            if (!file.startsWith(buildDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                file = path.join(buildDir, "index.html");
            }
            res.writeHead(200, { "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream" });
            fs.createReadStream(file).pipe(res);
        });
        return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
    }

    function fixtureToken(uid: string, email: string): string {
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
                sub: uid,
                user_id: uid,
            })
        }.fixture`;
    }

    async function installIsolatedAuthFixture(page: import("@playwright/test").Page, accounts: Map<string, string>) {
        await page.route("https://identitytoolkit.googleapis.com/**", async route => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("accounts:lookup")) {
                const request = route.request().postDataJSON() as { idToken?: string; };
                const payload = tokenPayload(request.idToken ?? "");
                const uid = payload.user_id;
                if (!uid || !payload.email || accounts.get(payload.email) !== uid) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/json",
                        body: '{"error":{"message":"INVALID_ID_TOKEN"}}',
                    });
                    return;
                }
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        users: [{
                            createdAt: "1700000000000",
                            email: payload.email,
                            emailVerified: true,
                            lastLoginAt: "1700000000000",
                            localId: uid,
                            providerUserInfo: [],
                        }],
                    }),
                });
                return;
            }
            if (!url.pathname.endsWith("accounts:signInWithPassword")) {
                await route.fulfill({
                    status: 400,
                    contentType: "application/json",
                    body: '{"error":{"message":"UNSUPPORTED"}}',
                });
                return;
            }
            const request = route.request().postDataJSON() as { email?: string; };
            const uid = request.email && accounts.get(request.email);
            if (!request.email || !uid) {
                await route.fulfill({
                    status: 400,
                    contentType: "application/json",
                    body: '{"error":{"message":"EMAIL_NOT_FOUND"}}',
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    email: request.email,
                    expiresIn: "3600",
                    idToken: fixtureToken(uid, request.email),
                    localId: uid,
                    refreshToken: `refresh-${uid}`,
                    registered: true,
                }),
            });
        });
    }

    async function readBindingFromWorker(page: import("@playwright/test").Page) {
        return page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            if (!registration.active) throw new Error("built worker is not active");
            const channel = new MessageChannel();
            const response = new Promise<{ binding: { fence: number; generation?: string; }; workerBootId: string; }>(
                (resolve, reject) => {
                    const timeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "built worker did not return its Web Push enrollment binding within 5 seconds",
                                ),
                            ),
                        5_000,
                    );
                    channel.port1.onmessage = event =>
                        event.data?.error
                            ? (clearTimeout(timeout), reject(new Error(event.data.error)))
                            : (clearTimeout(timeout), resolve(event.data));
                },
            );
            registration.active.postMessage("outliner:read-web-push-binding", [channel.port2]);
            return response;
        });
    }

    /** Same Chromium resolution as client/playwright.config.ts. */
    function chromiumExecutable(): string | undefined {
        const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
        if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
        const marker = path.join(repoRoot, ".playwright-chromium-path");
        const recorded = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
        return recorded && fs.existsSync(recorded) ? recorded : undefined;
    }

    test("the app registers the built worker, which activates, precaches and serves offline", async () => {
        // Relies on the production build made by the suite above.
        expect(fs.existsSync(path.join(buildDir, "service-worker.js"))).toBe(true);
        const { chromium } = createRequire(path.join(clientDir, "package.json"))(
            "@playwright/test",
        ) as typeof import("@playwright/test");
        const server = await serveBuild();
        const executablePath = chromiumExecutable();
        const browser = await chromium.launch({
            args: ["--no-sandbox"],
            ...(executablePath ? { executablePath } : {}),
        });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            await page.goto(`${base}/`);

            const manifest = await page.evaluate(async () => {
                const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
                if (!link) throw new Error("application did not publish a manifest link");
                const response = await fetch(link.href);
                return { url: response.url, status: response.status, body: await response.json() };
            });
            expect(manifest.url).toBe(`${base}/manifest.webmanifest`);
            expect(manifest.status).toBe(200);
            expect(manifest.body).to.include({ name: "Outliner", display: "standalone", start_url: "/" });
            expect(manifest.body.icons).to.deep.include({
                src: "/favicon.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "any maskable",
            });

            // No test code registers anything: this is the app's own manual
            // registration (src/routes/+layout.svelte) of the built worker.
            const worker = await page.evaluate(async () => {
                const within = <T>(promise: Promise<T>, what: string) =>
                    Promise.race([
                        promise,
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error(`service worker ${what} within 30s`)), 30_000)
                        ),
                    ]);
                const registration = await within(navigator.serviceWorker.ready, "was not registered and ready");
                const active = registration.active!;
                if (active.state !== "activated") {
                    await within(
                        new Promise<void>(resolve =>
                            active.addEventListener("statechange", () => active.state === "activated" && resolve())
                        ),
                        "did not activate",
                    );
                }
                const names = await caches.keys();
                const name = names.find(n => n.startsWith("outliner-cache-"));
                const cached = name
                    ? (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)
                    : [];
                return { scriptURL: active.scriptURL, state: active.state, names, cached };
            });
            expect(worker.scriptURL).toBe(`${base}/service-worker.js`);
            expect(worker.state).toBe("activated");
            expect(worker.names).toHaveLength(1);

            // The precache holds the shell, every emitted entry chunk and the static assets.
            expect(worker.cached).toContain("/");
            expect(worker.cached).toContain("/favicon.png");
            const entries = fs.readdirSync(path.join(buildDir, "_app/immutable/entry"));
            expect(entries.length).toBeGreaterThan(0);
            for (const entry of entries) {
                expect(worker.cached).toContain(`/_app/immutable/entry/${entry}`);
            }

            // Offline, a navigation to any app route is answered from the cache
            // with the app shell.
            await context.setOffline(true);
            const offline = await page.goto(`${base}/some-project/some-page`);
            expect(offline?.status()).toBe(200);
            expect(await page.content()).toContain("/_app/immutable/entry/");
        } finally {
            await browser.close();
            await new Promise(resolve => server.close(resolve));
        }
    }, 180_000);

    test("the built Settings gesture commits enrollment and arms the active worker binding", async () => {
        const { chromium } = createRequire(path.join(clientDir, "package.json"))(
            "@playwright/test",
        ) as typeof import("@playwright/test");
        const registrations: RegistrationObservation[] = [];
        const server = await serveBuild([], registrations);
        const executablePath = chromiumExecutable();
        const browser = await chromium.launch({
            args: ["--no-sandbox"],
            ...(executablePath ? { executablePath } : {}),
        });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const email = `push-settings-${suffix}@example.test`;
            const uid = `uid-settings-${suffix}`;
            await installIsolatedAuthFixture(page, new Map([[email, uid]]));
            await page.addInitScript(() => {
                let subscription: object | undefined;
                Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
                    configurable: true,
                    get: () => ({
                        getSubscription: async () => subscription,
                        subscribe: async (options: { applicationServerKey: ArrayBuffer; }) => {
                            subscription = {
                                endpoint: "https://push.example.test/built-settings",
                                options,
                                toJSON: () => ({
                                    endpoint: "https://push.example.test/built-settings",
                                    keys: { p256dh: "fixture-p256dh", auth: "fixture-auth" },
                                }),
                                unsubscribe: async () => (subscription = undefined, true),
                            };
                            return subscription;
                        },
                    }),
                });
            });
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            await page.goto(`${base}/`);
            await page.locator("#email").fill(email);
            await page.locator("#password").fill("isolated-password");
            await page.locator("button.email-login-btn").click();
            await expect(page.locator("button.logout-btn")).toBeVisible();
            await page.goto(`${base}/settings`);
            await expect(page.getByRole("button", { name: "Enable notifications" })).toBeVisible();
            await page.getByRole("button", { name: "Enable notifications" }).click();
            await expect(page.getByTestId("push-status")).toContainText("registered");
            await expect.poll(() => registrations).toHaveLength(1);
            expect(registrations[0]).toMatchObject({ uid });
            const binding = await readBindingFromWorker(page);
            expect(binding.binding.generation).toBe(registrations[0].enrollmentGeneration);
        } finally {
            await browser.close();
            await new Promise(resolve => server.close(resolve));
        }
    }, 180_000);

    test("a real disable overtakes registration admitted by the built Settings gesture", async () => {
        const { chromium } = createRequire(path.join(clientDir, "package.json"))(
            "@playwright/test",
        ) as typeof import("@playwright/test");
        const disables: DisableObservation[] = [];
        const registrations: RegistrationObservation[] = [];
        let observeRegistration!: () => void;
        const registrationStarted = new Promise<void>(resolve => observeRegistration = resolve);
        let releaseRegistration!: () => void;
        const registrationRelease = new Promise<void>(resolve => releaseRegistration = resolve);
        let observeRegistrationFinished!: () => void;
        const registrationFinished = new Promise<void>(resolve => observeRegistrationFinished = resolve);
        const server = await serveBuild(disables, registrations, {
            registrationStarted: observeRegistration,
            registrationFinished: observeRegistrationFinished,
            waitForRegistrationRelease: registrationRelease,
            disabled: () => disables.length > 0,
        });
        const executablePath = chromiumExecutable();
        const browser = await chromium.launch({
            args: ["--no-sandbox"],
            ...(executablePath ? { executablePath } : {}),
        });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const email = `push-race-${suffix}@example.test`;
            const uid = `uid-race-${suffix}`;
            await installIsolatedAuthFixture(page, new Map([[email, uid]]));
            await page.addInitScript(() => {
                let subscription: object | undefined;
                Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
                    configurable: true,
                    get: () => ({
                        getSubscription: async () => subscription,
                        subscribe: async (options: { applicationServerKey: ArrayBuffer; }) => {
                            subscription = {
                                endpoint: "https://push.example.test/built-race",
                                options,
                                toJSON: () => ({
                                    endpoint: "https://push.example.test/built-race",
                                    keys: { p256dh: "fixture-p256dh", auth: "fixture-auth" },
                                }),
                                unsubscribe: async () => (subscription = undefined, true),
                            };
                            return subscription;
                        },
                    }),
                });
            });
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            await page.goto(`${base}/`);
            await page.locator("#email").fill(email);
            await page.locator("#password").fill("isolated-password");
            await page.locator("button.email-login-btn").click();
            await expect(page.locator("button.logout-btn")).toBeVisible();
            await page.goto(`${base}/settings`);
            await page.getByRole("button", { name: "Enable notifications" }).click();
            await registrationStarted;

            await page.locator("button.logout-btn").click();
            await expect(page.locator(".email-login-form")).toBeVisible();
            await expect.poll(() => disables).toHaveLength(1);
            releaseRegistration();
            await registrationFinished;
            expect(registrations).toHaveLength(0);
            expect(disables[0]).toMatchObject({ uid });
        } finally {
            releaseRegistration();
            await browser.close();
            await new Promise(resolve => server.close(resolve));
        }
    }, 180_000);

    test("account switch keeps the prior enrollment disarmed across a built-worker restart", async () => {
        const { chromium } = createRequire(path.join(clientDir, "package.json"))(
            "@playwright/test",
        ) as typeof import("@playwright/test");
        const disables: DisableObservation[] = [];
        const server = await serveBuild(disables);
        const executablePath = chromiumExecutable();
        const browser = await chromium.launch({
            args: ["--no-sandbox"],
            ...(executablePath ? { executablePath } : {}),
        });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const accountA = `push-a-${suffix}@example.test`;
            const accountB = `push-b-${suffix}@example.test`;
            await installIsolatedAuthFixture(page,
                new Map([[accountA, `uid-a-${suffix}`], [accountB, `uid-b-${suffix}`]]));
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            await page.goto(`${base}/`);
            const firstWorker = await page.evaluate(async () =>
                (await navigator.serviceWorker.ready).active?.scriptURL
            );
            expect(firstWorker).toBe(`${base}/service-worker.js`);

            await page.locator("#email").fill(accountA);
            await page.locator("#password").fill("isolated-password-a");
            await page.locator("button.email-login-btn").click();
            await expect(page.locator("button.logout-btn")).toBeVisible();
            const deviceId = `account_a_device_${suffix}`.replace(/[^A-Za-z0-9_-]/gu, "_");
            await page.evaluate(async () => new Promise<void>((resolve, reject) => {
                localStorage.removeItem("outliner:web-push-armed");
                const open = indexedDB.open("outliner-web-push", 1);
                open.onupgradeneeded = () => open.result.createObjectStore("enrollment");
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const tx = open.result.transaction("enrollment", "readwrite");
                    tx.objectStore("enrollment").put({
                        fence: 11,
                        generation: "account_a_generation",
                        vapidKeyId: "key-1",
                    }, "current");
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                };
            }));
            await page.evaluate(id => localStorage.setItem("outliner:web-push-device", id), deviceId);
            const armedWorkerView = await readBindingFromWorker(page);
            expect(armedWorkerView.binding).toEqual({
                fence: 11,
                generation: "account_a_generation",
                vapidKeyId: "key-1",
            });

            await page.locator("button.logout-btn").click();
            await expect(page.locator(".email-login-form")).toBeVisible();
            await expect.poll(() => disables).toEqual([{ deviceId, uid: `uid-a-${suffix}` }]);
            await page.evaluate(async () => {
                const registration = await navigator.serviceWorker.ready;
                await registration.unregister();
                await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
            });
            const restartedWorkerView = await readBindingFromWorker(page);
            expect(restartedWorkerView.workerBootId).not.toBe(armedWorkerView.workerBootId);
            expect(restartedWorkerView.binding).toEqual({ fence: 12 });

            await page.locator("#email").fill(accountB);
            await page.locator("#password").fill("isolated-password-b");
            await page.locator("button.email-login-btn").click();
            await expect(page.locator("button.logout-btn")).toBeVisible();
            const accountBWorkerView = await readBindingFromWorker(page);
            expect(accountBWorkerView.workerBootId).toBe(restartedWorkerView.workerBootId);
            expect(accountBWorkerView.binding).toEqual({ fence: 12 });
        } finally {
            await browser.close();
            await new Promise(resolve => server.close(resolve));
        }
    }, 180_000);
});
