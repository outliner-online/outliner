import type { MobilePayloadV1 } from "$shared/notifications/mobile-payload";
import { updateEnrollmentBinding } from "./enrollmentBinding";

export function notificationFixture(generation = "current_enrollment_generation"): MobilePayloadV1 {
    return {
        schemaVersion: 1,
        eventId: "event-one",
        ruleId: "rule-one",
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

export async function resetNotificationBinding(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase("outliner-web-push");
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => reject(deletion.error);
    });
}

export async function armNotificationBinding(generation = "current_enrollment_generation"): Promise<void> {
    const { fence } = await updateEnrollmentBinding("read");
    await updateEnrollmentBinding("arm", { fence, generation, vapidKeyId: "key-one" });
}

export function barrier() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => release = resolve);
    return { promise, release };
}
