import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userManager } from "../../auth/UserManager";
import { BrowserPushRegistration } from "./browserPushRegistration";

const publicKey = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, index) => index + 1)]);
const publicKeyText = btoa(String.fromCharCode(...publicKey)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
const endpoint = "https://push.example.test/browser/lifecycle";

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function json(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("browser Web Push enrollment lifecycle", () => {
    let subscription: PushSubscription | undefined;
    let serverStatus: Record<string, unknown>;
    let subscribeCalls: number;
    let originalFetch: typeof fetch;
    let originalCurrentUser: PropertyDescriptor | undefined;

    beforeEach(async () => {
        await new Promise<void>(resolve => {
            const deletion = indexedDB.deleteDatabase("outliner-web-push");
            deletion.onsuccess = deletion.onerror = deletion.onblocked = () => resolve();
        });
        localStorage.clear();
        subscribeCalls = 0;
        serverStatus = { deviceId: "browser", revision: 0, state: "disabled" };
        const registration = {
            pushManager: {
                getSubscription: async () => subscription,
                subscribe: async (options: { applicationServerKey?: unknown; }) => {
                    subscribeCalls++;
                    subscription = {
                        endpoint,
                        options: { applicationServerKey: options.applicationServerKey as ArrayBuffer },
                        toJSON: () => ({
                            endpoint,
                            keys: { p256dh: "p256dh-key", auth: "authentication-key" },
                        }),
                        unsubscribe: async () => {
                            subscription = undefined;
                            return true;
                        },
                    } as PushSubscription;
                    return subscription;
                },
            },
        } as ServiceWorkerRegistration;
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
        originalCurrentUser = Object.getOwnPropertyDescriptor(userManager.auth, "currentUser");
        Object.defineProperty(userManager.auth, "currentUser", {
            configurable: true,
            value: { getIdToken: async () => "authenticated-token" },
        });
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const url = String(input);
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer authenticated-token");
            if (url.endsWith("/config")) {
                return json({ available: true, publicKey: publicKeyText, vapidKeyId: "key-1" });
            }
            if (url.endsWith("/admissions")) return json({ admissionFence: 1 });
            if (url.endsWith("/disable")) {
                serverStatus = { ...serverStatus, revision: 2, state: "disabled" };
                return json(serverStatus);
            }
            if (init?.method === "PUT") {
                serverStatus = {
                    deviceId: "browser",
                    revision: 1,
                    state: "registered",
                    vapidKeyId: "key-1",
                    endpointHash: await sha256(endpoint),
                };
                return json(serverStatus);
            }
            return json(serverStatus);
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalCurrentUser) Object.defineProperty(userManager.auth, "currentUser", originalCurrentUser);
        else delete (userManager.auth as { currentUser?: unknown; }).currentUser;
    });

    it("subscribes from the prepared enrollment action and reconciles the matching committed subscription", async () => {
        const enrollment = new BrowserPushRegistration();
        await enrollment.reconcile();
        expect(enrollment.status).toBe("not-enrolled");

        await enrollment.enroll();
        expect(subscribeCalls).toBe(1);
        expect(enrollment.status).toBe("registered");

        const reopenedSettings = new BrowserPushRegistration();
        await reopenedSettings.reconcile();
        expect(reopenedSettings.status).toBe("registered");
        expect(subscribeCalls).toBe(1);
    });

    it("keeps a completed cross-context disarm effective against a delayed enrollment arm", async () => {
        let releaseRegistration!: () => void;
        const registrationBarrier = new Promise<void>(resolve => releaseRegistration = resolve);
        const immediateFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (init?.method === "PUT") await registrationBarrier;
            return immediateFetch(input, init);
        };

        const delayedEnrollment = new BrowserPushRegistration();
        await delayedEnrollment.reconcile();
        const pending = delayedEnrollment.enroll();
        await new Promise(resolve => setTimeout(resolve, 0));

        const otherContext = new BrowserPushRegistration();
        await otherContext.disable();
        expect(otherContext.status).toBe("disabled");
        releaseRegistration();
        await pending;
        expect(delayedEnrollment.status).toBe("failed");

        const afterRestart = new BrowserPushRegistration();
        await afterRestart.reconcile();
        expect(afterRestart.status).toBe("not-enrolled");
        expect(localStorage.getItem("outliner:web-push-armed")).toBeNull();
    });
});
