import {
    createAdmission,
    disablePushDevice,
    getPushConfig,
    getPushStatus,
    type PushStatus,
    registerPushDevice,
} from "./pushDeviceClient";

const DEVICE_KEY = "outliner:web-push-device";
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
function deviceId(): string {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
        id = randomId();
        localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
}
function binding(value?: { generation: string; vapidKeyId: string; } | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            value ? store.put(value, "current") : store.delete("current");
            tx.oncomplete = () => {
                open.result.close();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
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
            const [config, registration, server] = await Promise.all([getPushConfig(), worker(),
                getPushStatus(deviceId())]);
            this.config = config;
            this.registration = registration;
            this.serverStatus = server;
            const subscription = await registration.pushManager.getSubscription();
            this.status = server.state === "registered" && !!subscription && Notification.permission === "granted"
                    && server.vapidKeyId === config.vapidKeyId
                ? "registered"
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
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: decodeKey(config.publicKey),
            });
            const json = subscription.toJSON();
            const enrollmentGeneration = randomId();
            const status = await registerPushDevice(deviceId(), {
                expectedRevision: this.serverStatus?.revision ?? 0,
                admissionFence: await createAdmission(),
                enrollmentGeneration,
                vapidKeyId: config.vapidKeyId,
                subscription: { endpoint: subscription.endpoint, keys: json.keys },
            });
            if (generation !== this.operation) return;
            await binding({ generation: enrollmentGeneration, vapidKeyId: config.vapidKeyId });
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
            await binding();
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
            const subscription = await (await worker()).pushManager.getSubscription();
            if (subscription && !await subscription.unsubscribe()) failed.push("browser subscription");
        } catch {
            failed.push("browser subscription");
        }
        this.status = failed.length ? "incomplete" : "disabled";
        this.detail = failed.length ? `Incomplete cleanup: ${failed.join(", ")}` : "";
    }
}
