import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userManager } from "../../auth/UserManager";
import PushDeviceSettings from "../../components/notifications/PushDeviceSettings.svelte";
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
                const registration = JSON.parse(String(init.body)) as { enrollmentGeneration: string; };
                serverStatus = {
                    deviceId: "browser",
                    revision: 1,
                    state: "registered",
                    vapidKeyId: "key-1",
                    endpointHash: await sha256(endpoint),
                    enrollmentGeneration: registration.enrollmentGeneration,
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

    it("shows a stale Settings binding as inactive until a fresh button gesture repairs it", async () => {
        subscription = {
            endpoint: "https://push.example.test/stale-subscription",
            options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
            unsubscribe: async () => {
                subscription = undefined;
                return true;
            },
            toJSON: () => ({}),
        } as PushSubscription;
        serverStatus = {
            deviceId: "browser",
            revision: 1,
            state: "registered",
            vapidKeyId: "key-1",
            endpointHash: await sha256("https://push.example.test/stale-subscription"),
        };

        render(PushDeviceSettings);
        await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("not enrolled"));
        await waitFor(() => expect(subscription).toBeUndefined());
        expect(subscribeCalls).toBe(0);

        await fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
        await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("registered"));
        expect(subscribeCalls).toBe(1);
    });

    it("shows enrollment progress immediately and hides the enable action until the commit finishes", async () => {
        let releaseRegistration!: () => void;
        const registrationBarrier = new Promise<void>(resolve => releaseRegistration = resolve);
        const immediateFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (init?.method === "PUT") await registrationBarrier;
            return immediateFetch(input, init);
        };

        render(PushDeviceSettings);
        const enable = await screen.findByRole("button", { name: "Enable notifications" });
        await fireEvent.click(enable);
        expect(screen.getByTestId("push-status")).toHaveTextContent("Enrolling this browser");
        expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull();

        releaseRegistration();
        await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("registered"));
    });

    it("does not reconcile a committed server device after its durable local generation is disarmed", async () => {
        const enrollment = new BrowserPushRegistration();
        await enrollment.reconcile();
        await enrollment.enroll();
        expect(enrollment.status).toBe("registered");

        const committedSubscription = subscription!;
        committedSubscription.unsubscribe = async () => false;
        const immediateFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) =>
            String(input).endsWith("/disable")
                ? json({ error: "persistence_unavailable" }, 503)
                : immediateFetch(input, init);
        const disarmer = new BrowserPushRegistration();
        await disarmer.disable();
        expect(disarmer.status).toBe("incomplete");
        expect(subscription).toBe(committedSubscription);
        expect(serverStatus.state).toBe("registered");

        const reopenedSettings = new BrowserPushRegistration();
        await reopenedSettings.reconcile();
        expect(reopenedSettings.status).toBe("not-enrolled");
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
        expect(["disabled", "incomplete"]).toContain(otherContext.status);
        expect(otherContext.detail).not.toBe("Could not verify local disarm");
        releaseRegistration();
        await pending;
        expect(delayedEnrollment.status).toBe("failed");

        const afterRestart = new BrowserPushRegistration();
        await afterRestart.reconcile();
        expect(afterRestart.status).toBe("not-enrolled");
        expect(localStorage.getItem("outliner:web-push-armed")).toBeNull();
    });
});
