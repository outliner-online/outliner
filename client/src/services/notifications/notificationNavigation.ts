import { type MobilePayloadV1, validateMobilePayload } from "$shared/notifications/mobile-payload";
import { initiateForEnrollment } from "./enrollmentBinding";

export interface NotificationWindow {
    readonly url: string;
    focus(): Promise<NotificationWindow>;
    navigate(url: string): Promise<NotificationWindow | null>;
}
export interface NotificationClients {
    matchAll(options: { type: "window"; includeUncontrolled: boolean; }): Promise<readonly NotificationWindow[]>;
    openWindow(url: string): Promise<NotificationWindow | null>;
}

/** Navigate the current authorized application; notification data cannot restore old content. */
export async function navigateMobileNotification(
    input: unknown,
    origin: string,
    clients: NotificationClients,
): Promise<void> {
    const payload: MobilePayloadV1 | undefined = validateMobilePayload(input);
    if (!payload) return;
    const destination = new URL(payload.href, origin);
    if (destination.origin !== origin) return;
    const windows = (await clients.matchAll({ type: "window", includeUncontrolled: true })).filter(client => {
        try {
            return new URL(client.url).origin === origin;
        } catch {
            return false;
        }
    });
    const existing = windows.find(client => client.url === destination.href) ?? windows[0];
    const gate = <T>(start: () => Promise<T>) => initiateForEnrollment(payload.enrollmentGeneration, start);
    if (!existing) {
        await gate(() => clients.openWindow(destination.href));
        return;
    }
    if (existing.url === destination.href) {
        await gate(() => existing.focus());
        return;
    }
    // Client discovery and navigation completion may each race durable disarm.
    const navigation = await gate(() => existing.navigate(destination.href));
    if (!navigation.initiated) return;
    if (navigation.value) await gate(() => navigation.value!.focus());
    else await gate(() => clients.openWindow(destination.href));
}
