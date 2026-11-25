import {
    createAdmission,
    disablePushDevice,
    getPushConfig,
    getPushStatus,
    type PushStatus,
    registerPushDevice,
} from "./pushDeviceClient";

const DEVICE_KEY = "outliner:web-push-device";
const ARMED_HINT_KEY = "outliner:web-push-armed";
const DB = "outliner-web-push";
const STORE = "enrollment";
export type EnrollmentView =
    | "unsupported"
    | "denied"
    | "unavailable"
    | "not-enrolled"
    | "enrolling"
    | "registered"
    | "disabled"
    | "failed"
    | "incomplete";
function randomId(): string {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/gu, "-").replace(/\//gu,
        "_").replace(/=+$/gu, "");
}
function decodeKey(value: string): Uint8Array {
    const text = value.replace(/-/gu, "+").replace(/_/gu, "/");
    return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}
function sameBytes(left: ArrayBuffer | null, right: Uint8Array): boolean {
    if (!left) return false;
    const value = new Uint8Array(left);
    return value.length === right.length && value.every((byte, index) => byte === right[index]);
}
async function endpointHash(endpoint: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function deviceId(): string {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
        id = randomId();
        localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
}
interface EnrollmentBinding {
    fence: number;
    generation?: string;
    vapidKeyId?: string;
}
function updateBinding(operation: "read" | "disarm" | "arm", value?: EnrollmentBinding): Promise<EnrollmentBinding> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction(STORE, operation === "read" ? "readonly" : "readwrite");
            const store = tx.objectStore(STORE);
            const request = store.get("current");
            let result: EnrollmentBinding = { fence: 0 };
            request.onsuccess = () => {
                const current = (request.result as EnrollmentBinding | undefined) ?? { fence: 0 };
                if (operation === "read") result = current;
                else if (operation === "disarm") {
                    result = { fence: current.fence + 1 };
                    store.put(result, "current");
                } else {
                    if (!value || current.fence !== value.fence || current.generation) {
                        tx.abort();
                        return;
                    }
                    result = value;
                    store.put(result, "current");
                }
            };
            tx.oncomplete = () => {
                if (result.generation) localStorage.setItem(ARMED_HINT_KEY, "true");
                else if (operation === "disarm") localStorage.removeItem(ARMED_HINT_KEY);
                open.result.close();
                resolve(result);
            };
            tx.onabort = tx.onerror = () => {
                open.result.close();
                reject(tx.error ?? new Error("Enrollment binding changed"));
            };
        };
    });
}
async function worker(): Promise<ServiceWorkerRegistration> {
    return navigator.serviceWorker.ready;
}
function supported(): boolean {
    return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window
        && "Notification" in window;
}

export class BrowserPushRegistration {
    private operation = 0;
    private config?: Awaited<ReturnType<typeof getPushConfig>>;
    private registration?: ServiceWorkerRegistration;
    private serverStatus?: PushStatus;
    private subscription?: PushSubscription;
    private bindingFence?: number;
    status: EnrollmentView = "not-enrolled";
    detail = "";
    async reconcile(): Promise<void> {
        if (!supported()) {
            this.status = "unsupported";
            return;
        }
        if (Notification.permission === "denied") {
            this.status = "denied";
            return;
        }
        try {
            const [config, registration, server, binding] = await Promise.all([getPushConfig(), worker(),
                getPushStatus(deviceId()), updateBinding("read")]);
            this.config = config;
            this.registration = registration;
            this.serverStatus = server;
            this.bindingFence = binding.fence;
            const subscription = await registration.pushManager.getSubscription();
            const keyMatches = !!subscription
                && sameBytes(subscription.options.applicationServerKey, decodeKey(config.publicKey));
            if (subscription && !keyMatches) await subscription.unsubscribe();
            this.subscription = keyMatches ? subscription : undefined;
            const matches = keyMatches && !!subscription
                && server.endpointHash === await endpointHash(subscription.endpoint);
            this.status = server.state === "registered" && matches && Notification.permission === "granted"
                    && server.vapidKeyId === config.vapidKeyId && !!binding.generation
                    && binding.generation === server.enrollmentGeneration
                ? "registered"
                : server.state === "disabled" && server.revision > 0
                ? "disabled"
                : "not-enrolled";
        } catch (error) {
            this.status = "unavailable";
            this.detail = error instanceof Error ? error.message : "Unavailable";
        }
    }
    /** Must be invoked directly by the settings button's click handler. */
    async enroll(): Promise<void> {
        const generation = ++this.operation;
        this.status = "enrolling";
        try {
            // Configuration and worker readiness were prepared before this
            // gesture, preserving transient activation for subscribe().
            const config = this.config;
            const registration = this.registration;
            if (!config || !registration) throw new Error("Enrollment is not ready");
            if (this.bindingFence === undefined) throw new Error("Enrollment binding is not ready");
            const applicationServerKey = decodeKey(config.publicKey);
            let subscription = this.subscription;
            if (subscription && !sameBytes(subscription.options.applicationServerKey, applicationServerKey)) {
                throw new Error("Existing subscription must be reconciled before enrollment");
            }
            subscription ??= await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
            });
            const json = subscription.toJSON();
            const enrollmentGeneration = randomId();
            const currentDeviceId = deviceId();
            if (generation !== this.operation) return;
            const admissionFence = await createAdmission(currentDeviceId);
            if (generation !== this.operation) {
                await disablePushDevice(currentDeviceId);
                return;
            }
            const status = await registerPushDevice(currentDeviceId, {
                expectedRevision: this.serverStatus?.revision ?? 0,
                admissionFence,
                enrollmentGeneration,
                vapidKeyId: config.vapidKeyId,
                subscription: { endpoint: subscription.endpoint, keys: json.keys },
            });
            if (generation !== this.operation) {
                await disablePushDevice(currentDeviceId);
                return;
            }
            if (status.enrollmentGeneration !== enrollmentGeneration) {
                throw new Error("Committed enrollment generation does not match this enrollment");
            }
            try {
                await updateBinding("arm", {
                    fence: this.bindingFence,
                    generation: status.enrollmentGeneration,
                    vapidKeyId: config.vapidKeyId,
                });
            } catch (error) {
                await disablePushDevice(currentDeviceId);
                throw error;
            }
            if (generation === this.operation && status.state === "registered") {
                this.serverStatus = status;
                this.status = "registered";
            }
        } catch (error) {
            if (generation === this.operation) {
                this.status = Notification.permission === "denied" ? "denied" : "failed";
                this.detail = error instanceof Error ? error.message : "Enrollment failed";
            }
        }
    }
    async disable(): Promise<void> {
        ++this.operation;
        const failed: string[] = [];
        try {
            await updateBinding("disarm");
        } catch {
            failed.push("local disarm");
        }
        if (failed.length) {
            this.status = "incomplete";
            this.detail = "Could not verify local disarm";
            return;
        }
        try {
            await disablePushDevice(deviceId());
        } catch {
            failed.push("server registration");
        }
        try {
            // Ordinary E2E and development intentionally suppress automatic
            // worker registration. Do not wait on `serviceWorker.ready` during
            // logout: it never settles when no registration exists.
            const registration = await navigator.serviceWorker?.getRegistration("/");
            const subscription = await registration?.pushManager.getSubscription();
            if (subscription && !await subscription.unsubscribe()) failed.push("browser subscription");
        } catch {
            failed.push("browser subscription");
        }
        this.status = failed.length ? "incomplete" : "disabled";
        this.detail = failed.length ? `Incomplete cleanup: ${failed.join(", ")}` : "";
    }
}
