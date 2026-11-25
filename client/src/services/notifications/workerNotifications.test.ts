import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { updateEnrollmentBinding } from "./enrollmentBinding";
import { armNotificationBinding, notificationFixture, resetNotificationBinding } from "./notification.fixture";
import {
    handleMobileNotificationClick,
    handleMobilePush,
    type MobileNotificationOptions,
    type MobileNotificationScope,
} from "./workerNotifications";

describe("worker push and activation handlers", () => {
    beforeEach(resetNotificationBinding);

    it("displays bounded text and observation time for every valid current push, even with a foreground client", async () => {
        await armNotificationBinding();
        const shown: { title: string; options: MobileNotificationOptions; }[] = [];
        const scope: MobileNotificationScope = {
            location: { origin: "https://outliner.example" },
            registration: {
                showNotification: async (title, options) => {
                    shown.push({ title, options });
                },
            },
            clients: {
                matchAll: async () => {
                    throw new Error("Foreground clients are not push authority");
                },
                openWindow: async () => null,
            },
        };
        const payload = notificationFixture();
        let pending: Promise<unknown> | undefined;
        handleMobilePush(scope, {
            data: { text: () => JSON.stringify(payload) },
            waitUntil: promise => pending = promise,
        });
        expect(pending).toBeDefined();
        await pending;
        expect(shown).toEqual([{
            title: payload.title,
            options: {
                body: `${payload.body}\nObserved ${payload.observedAt}`,
                timestamp: Date.parse(payload.observedAt),
                tag: payload.ruleId,
                data: payload,
            },
        }]);
        await updateEnrollmentBinding("disarm");
        await armNotificationBinding("new_enrollment_generation");
        for (
            const raw of [JSON.stringify(payload), "{broken", " ".repeat(3001),
                JSON.stringify({ ...payload, href: "/settings" })]
        ) {
            handleMobilePush(scope, { data: { text: () => raw }, waitUntil: promise => pending = promise });
            await pending;
        }
        expect(shown).toHaveLength(1);
    });

    it("closes a stale notification without initiating focus, navigation or open", async () => {
        await armNotificationBinding();
        await updateEnrollmentBinding("disarm");
        let closed = 0;
        let navigations = 0;
        let pending: Promise<unknown> | undefined;
        const scope: MobileNotificationScope = {
            location: { origin: "https://outliner.example" },
            registration: { showNotification: async () => {} },
            clients: { matchAll: async () => [], openWindow: async () => (navigations++, null) },
        };
        handleMobileNotificationClick(scope, {
            notification: {
                data: notificationFixture(),
                close: () => {
                    closed++;
                },
            },
            waitUntil: promise => pending = promise,
        });
        await pending;
        expect(closed).toBe(1);
        expect(navigations).toBe(0);
    });
});
