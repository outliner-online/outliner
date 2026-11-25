import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { updateEnrollmentBinding } from "./enrollmentBinding";
import { armNotificationBinding, barrier, notificationFixture, resetNotificationBinding } from "./notification.fixture";
import {
    navigateMobileNotification,
    type NotificationClients,
    type NotificationWindow,
} from "./notificationNavigation";

const origin = "https://outliner.example";

describe("notification navigation with current local authority", () => {
    beforeEach(resetNotificationBinding);

    it("opens the exact context when no same-origin application window exists", async () => {
        await armNotificationBinding();
        const opened: string[] = [];
        const foreign = { url: "https://other.example/" } as NotificationWindow;
        const clients: NotificationClients = {
            matchAll: async () => [foreign],
            openWindow: async url => (opened.push(url), null),
        };
        const payload = notificationFixture();
        await navigateMobileNotification(payload, origin, clients);
        expect(opened).toEqual([`${origin}${payload.href}`]);
    });

    it("rechecks after client discovery so a verified disarm blocks every navigation initiation", async () => {
        await armNotificationBinding();
        const entered = barrier();
        const release = barrier();
        const effects: string[] = [];
        const client: NotificationWindow = {
            url: `${origin}/settings`,
            navigate: async url => (effects.push(url), client),
            focus: async () => (effects.push("focus"), client),
        };
        const pending = navigateMobileNotification(notificationFixture(), origin, {
            matchAll: async () => (entered.release(), await release.promise, [client]),
            openWindow: async url => (effects.push(url), null),
        });
        await entered.promise;
        await updateEnrollmentBinding("disarm");
        release.release();
        await pending;
        expect(effects).toEqual([]);
    });

    it("orders a later focus separately from an already initiated navigation", async () => {
        await armNotificationBinding();
        const entered = barrier();
        const release = barrier();
        const effects: string[] = [];
        const client: NotificationWindow = {
            url: `${origin}/settings`,
            navigate: async url => (effects.push(url), entered.release(), await release.promise, client),
            focus: async () => (effects.push("focus"), client),
        };
        const payload = notificationFixture();
        const pending = navigateMobileNotification(payload, origin, {
            matchAll: async () => [client],
            openWindow: async url => (effects.push(url), null),
        });
        await entered.promise;
        await updateEnrollmentBinding("disarm");
        release.release();
        await pending;
        expect(effects).toEqual([`${origin}${payload.href}`]);
    });

    it("focuses an existing exact-context window and rejects malformed, foreign and unrelated URLs", async () => {
        await armNotificationBinding();
        const payload = notificationFixture();
        const effects: string[] = [];
        const client: NotificationWindow = {
            url: `${origin}${payload.href}`,
            navigate: async url => (effects.push(url), client),
            focus: async () => (effects.push("focus"), client),
        };
        const clients: NotificationClients = {
            matchAll: async () => [client],
            openWindow: async url => (effects.push(url), null),
        };
        await navigateMobileNotification(payload, origin, clients);
        expect(effects).toEqual(["focus"]);
        for (
            const href of ["https://other.example/x", "//other.example/x", "/settings", "/%/invalid",
                "javascript:alert(1)"]
        ) {
            await navigateMobileNotification({ ...payload, href }, origin, clients);
        }
        expect(effects).toEqual(["focus"]);
    });
});
