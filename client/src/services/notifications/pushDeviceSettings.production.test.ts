import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { createECDH } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userManager } from "../../auth/UserManager";
import PushDeviceSettings from "../../components/notifications/PushDeviceSettings.svelte";

const requireFromServer = createRequire(path.resolve(process.cwd(), "../server/package.json"));
const Database = requireFromServer("better-sqlite3") as new(filename: string) => { close(): void; };
const publicKey = createECDH("prime256v1").generateKeys();

describe("production Settings Web Push enrollment boundary", () => {
    const originalFetch = globalThis.fetch;
    const originalCurrentUser = Object.getOwnPropertyDescriptor(userManager.auth, "currentUser");

    afterEach(() => {
        globalThis.fetch = originalFetch;
        localStorage.clear();
        if (originalCurrentUser) Object.defineProperty(userManager.auth, "currentUser", originalCurrentUser);
    });

    it("commits the gesture-created subscription through the authenticated router and SQLite store", async () => {
        const { createPushDeviceRouter } = await import(
            /* @vite-ignore */ path.resolve(process.cwd(), "../server/src/notifications/push-device-api.ts")
        );
        const { PushDeviceStore } = await import(
            /* @vite-ignore */ path.resolve(process.cwd(), "../server/src/notifications/push-device-store.ts")
        );
        const { default: express } = await import(
            /* @vite-ignore */ path.resolve(process.cwd(), "../server/node_modules/express/index.js")
        );
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const app = express();
        app.use(express.json());
        app.use("/api", createPushDeviceRouter({
            store,
            config: {
                publicKey: publicKey.toString("base64url"),
                privateKey: Buffer.alloc(32, 1).toString("base64url"),
                vapidKeyId: "production-key",
                subject: "mailto:push@example.test",
            },
            verifyToken: async (token: string) => {
                if (token !== "owner-a-token") throw new Error("invalid token");
                return { uid: "owner-a" } as never;
            },
        }));
        const server = app.listen(0);
        await new Promise<void>(resolve => server.once("listening", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        const subscription = {
            endpoint: "https://push.example.test/settings-production",
            options: { applicationServerKey: publicKey.buffer },
            toJSON: () => ({
                endpoint: "https://push.example.test/settings-production",
                keys: {
                    p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
                    auth: Buffer.alloc(16, 7).toString("base64url"),
                },
            }),
            unsubscribe: async () => true,
        } as unknown as PushSubscription;
        const registration = {
            pushManager: {
                getSubscription: async () => undefined,
                subscribe: async () => subscription,
            },
        } as unknown as ServiceWorkerRegistration;
        Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
        Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
        Object.defineProperty(window, "Notification", {
            configurable: true,
            value: class Notification {
                static permission = "granted";
            },
        });
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: { ready: Promise.resolve(registration), getRegistration: async () => registration },
        });
        Object.defineProperty(userManager.auth, "currentUser", {
            configurable: true,
            value: { getIdToken: async () => "owner-a-token" },
        });
        globalThis.fetch = (input, init) => {
            const url = new URL(String(input));
            return originalFetch(`${origin}${url.pathname}`, init);
        };

        try {
            render(PushDeviceSettings);
            await fireEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
            await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("registered"));
            expect(store.list("owner-a")).toEqual([
                expect.objectContaining({ state: "registered", vapidKeyId: "production-key" }),
            ]);
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error?: Error) => error ? reject(error) : resolve())
            );
            db.close();
        }
    });
});
