import { createHmac } from "node:crypto";
import { generateRequestDetails } from "web-push";
import { type HttpsSendOutcome, sendNotificationHttps, validateNotificationHeaders } from "./https-transport.js";
import { buildMobilePayload } from "./mobile-payload.js";
import type { NotificationObservationRuntime } from "./observation-runtime.js";
import type { PreparedViewChange, ViewChangeAttemptOutcome } from "./prepared-view-change.js";
import { loadPushConfig, type PushConfig } from "./push-config.js";
import { type PushDeviceStore, type RegisteredPushDevice } from "./push-device-store.js";

export { buildMobilePayload } from "./mobile-payload.js";

export interface WebPushDeliveryOptions {
    config?: () => PushConfig | undefined;
    transport?: typeof sendNotificationHttps;
    onResult?: (outcome: ViewChangeAttemptOutcome) => void;
}

type Outcome = ViewChangeAttemptOutcome["outcome"];
const TRANSPORT_HEADERS = new Set(["host", "content-length", "connection"]);

/** One bounded, process-local best-effort opportunity per producer callback. */
export class WebPushDeliveryAdapter {
    private readonly unsubscribe: () => void;
    private readonly controllers = new Set<AbortController>();
    private readonly config: () => PushConfig | undefined;
    private readonly transport: typeof sendNotificationHttps;
    private stopped = false;

    constructor(
        runtime: NotificationObservationRuntime,
        private readonly store: PushDeviceStore | undefined,
        private readonly options: WebPushDeliveryOptions = {},
    ) {
        this.config = options.config ?? loadPushConfig;
        this.transport = options.transport ?? sendNotificationHttps;
        this.unsubscribe = runtime.subscribe("mobile", (candidate, uid) => this.deliver(candidate, uid));
    }

    close(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.unsubscribe();
        for (const controller of this.controllers) controller.abort();
    }

    private async deliver(candidate: PreparedViewChange, uid: string): Promise<void> {
        let outcome: ViewChangeAttemptOutcome = { initiated: false, outcome: "failed" };
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            if (this.stopped) {
                outcome = { initiated: false, outcome: "cancelled" };
                return;
            }
            if (!this.store) return;
            const configured = this.config();
            if (!configured) return;
            const config = Object.freeze({ ...configured });
            const devices = this.store.getRegisteredForOwner(uid);
            if (devices.length === 0) {
                outcome = { initiated: false, outcome: "no_destination" };
                return;
            }
            const deadline = Date.now() + 10_000;
            // The store enforces at most 16 active devices. Start the entire
            // captured set independently so a slow destination cannot starve
            // a later device in a serial wave. The runtime bounds opportunities.
            const results = await Promise.all(
                devices.map(device => this.send(candidate, uid, device, config, controller, deadline)),
            );
            outcome = aggregate(results);
        } catch {
            // Config/store failures occur before fanout; each started transport
            // resolves to its own initiation-bearing result below.
        } finally {
            this.controllers.delete(controller);
            candidate.settleAttempt(outcome);
            // A completion from a retired adapter cannot mutate status or
            // report a fabricated success in a replacement server lifetime.
            if (!this.stopped) {
                try {
                    this.options.onResult?.(outcome);
                } catch {
                    // Observability must never prevent producer settlement.
                }
            }
        }
    }

    private currentDevice(uid: string, device: RegisteredPushDevice, config: PushConfig): boolean {
        if (this.stopped || !this.store) return false;
        try {
            const currentConfig = this.config();
            if (
                !currentConfig || currentConfig.vapidKeyId !== config.vapidKeyId
                || currentConfig.publicKey !== config.publicKey || currentConfig.privateKey !== config.privateKey
                || currentConfig.subject !== config.subject || device.vapidKeyId !== config.vapidKeyId
            ) return false;
            const current = this.store.getCurrent(uid, device.deviceId);
            return !!current && current.revision === device.revision && current.vapidKeyId === config.vapidKeyId
                && current.enrollmentGeneration === device.enrollmentGeneration && current.endpoint === device.endpoint
                && current.p256dh === device.p256dh && current.auth === device.auth;
        } catch {
            return false;
        }
    }

    private async send(
        candidate: PreparedViewChange,
        uid: string,
        device: RegisteredPushDevice,
        config: PushConfig,
        controller: AbortController,
        deadline: number,
    ): Promise<ViewChangeAttemptOutcome> {
        let result: HttpsSendOutcome | undefined;
        let refusal: Outcome | undefined;
        try {
            if (!this.currentDevice(uid, device, config)) {
                return { initiated: false, outcome: this.stopped ? "cancelled" : "failed" };
            }
            const payload = buildMobilePayload(candidate, device.enrollmentGeneration);
            if (!payload) return { initiated: false, outcome: "failed" };
            const capturedCandidate = JSON.stringify(candidate);
            const details = generateRequestDetails({
                endpoint: device.endpoint,
                keys: { p256dh: device.p256dh, auth: device.auth },
            }, JSON.stringify(payload), {
                contentEncoding: "aes128gcm",
                vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
                TTL: 60,
                urgency: "normal",
                topic: createHmac("sha256", config.privateKey).update(JSON.stringify([
                    uid,
                    candidate.ruleId,
                    device.deviceId,
                ])).digest("base64url").slice(0, 32),
            });
            const headers = Object.fromEntries(Object.entries(details.headers)
                .filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()))
                .map(([name, value]) => [name.toLowerCase(), String(value)]));
            if (
                details.method !== "POST" || details.endpoint !== device.endpoint || !Buffer.isBuffer(details.body)
                || !/^vapid\s/u.test(headers.authorization ?? "") || !validateNotificationHeaders("web-push", headers)
            ) return { initiated: false, outcome: "failed" };
            const body = Buffer.from(details.body);
            result = await this.transport({
                url: details.endpoint,
                headerProfile: "web-push",
                responseMode: "status",
                authorizationDeadlineMs: deadline,
                signal: controller.signal,
                canStart: () => this.currentDevice(uid, device, config),
                beforeSend: async () => {
                    if (!this.currentDevice(uid, device, config)) return null;
                    const checked = await candidate.revalidate();
                    if (checked.status !== "current") {
                        refusal = checked.reason === "expired" ? "expired" : checked.status;
                        return null;
                    }
                    // B ciphertext can be used only with the same immutable
                    // candidate, never with replacement C evidence.
                    if (JSON.stringify(checked.candidate) !== capturedCandidate) {
                        refusal = "deferred";
                        return null;
                    }
                    return {
                        body,
                        headers,
                        isCurrent: () => {
                            if (this.stopped) {
                                refusal = "cancelled";
                                return false;
                            }
                            if (!checked.candidate.isCurrent()) {
                                refusal = "cancelled";
                                return false;
                            }
                            return this.currentDevice(uid, device, config);
                        },
                    };
                },
            });
            if (this.stopped) return { initiated: result.writeInitiated, outcome: "cancelled" };
            if (result.kind === "accepted") return { initiated: result.writeInitiated, outcome: "accepted" };
            if (result.kind === "http_error" && (result.status === 404 || result.status === 410)) {
                this.store!.expireIfRevision(uid, device.deviceId, device.revision);
                return { initiated: result.writeInitiated, outcome: "expired" };
            }
            return {
                initiated: result.writeInitiated,
                outcome: refusal ?? (result.kind === "unknown" ? "unknown" : "failed"),
            };
        } catch {
            // SDK, persistence and local formatting errors never disclose
            // credentials or payloads. The shared transport returns its own
            // initiation evidence even for ambiguous connection failures.
            return { initiated: result?.writeInitiated ?? false, outcome: "failed" };
        }
    }
}

function aggregate(results: readonly ViewChangeAttemptOutcome[]): ViewChangeAttemptOutcome {
    const initiated = results.some(result => result.initiated);
    const outcomes = new Set(results.map(result => result.outcome));
    const precedence: readonly Outcome[] = initiated
        ? ["accepted", "unknown", "expired", "failed", "deferred", "cancelled"]
        : ["deferred", "cancelled", "expired", "failed", "no_destination"];
    return { initiated, outcome: precedence.find(value => outcomes.has(value)) ?? "failed" };
}
