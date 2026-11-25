import {
    MAX_MOBILE_PAYLOAD_BYTES,
    type MobilePayloadV1,
    validateMobilePayload,
} from "$shared/notifications/mobile-payload";
import { initiateForEnrollment } from "./enrollmentBinding";
import { navigateMobileNotification, type NotificationClients } from "./notificationNavigation";

export interface MobileNotificationOptions {
    body: string;
    timestamp: number;
    tag: string;
    data: MobilePayloadV1;
}
export interface MobileNotificationScope {
    readonly location: { readonly origin: string; };
    readonly registration: {
        showNotification(title: string, options: MobileNotificationOptions): Promise<void>;
    };
    readonly clients: NotificationClients;
}
export interface MobilePushEvent {
    readonly data: { text(): string; } | null;
    waitUntil(promise: Promise<unknown>): void;
}
export interface MobileClickEvent {
    readonly notification: { readonly data: unknown; close(): void; };
    waitUntil(promise: Promise<unknown>): void;
}

export function handleMobilePush(scope: MobileNotificationScope, event: MobilePushEvent): void {
    event.waitUntil((async () => {
        try {
            const text = event.data?.text();
            if (!text || new TextEncoder().encode(text).byteLength > MAX_MOBILE_PAYLOAD_BYTES) return;
            const payload = validateMobilePayload(JSON.parse(text));
            if (!payload) return;
            const options: MobileNotificationOptions = {
                body: `${payload.body}\nObserved ${payload.observedAt}`,
                timestamp: Date.parse(payload.observedAt),
                tag: payload.ruleId,
                data: payload,
            };
            await initiateForEnrollment(
                payload.enrollmentGeneration,
                () => scope.registration.showNotification(payload.title, options),
            );
        } catch {
            // Unreadable binding or malformed push is not display authority.
        }
    })());
}

export function handleMobileNotificationClick(scope: MobileNotificationScope, event: MobileClickEvent): void {
    event.notification.close();
    event.waitUntil(navigateMobileNotification(event.notification.data, scope.location.origin, scope.clients).catch(
        () => {
            // Closed/stale/unreadable notifications have no fallback destination.
        },
    ));
}
