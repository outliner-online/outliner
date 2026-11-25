import { AuthMessageType } from "@hocuspocus/common";
import { MessageType } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { messageYjsSyncStep2 } from "y-protocols/sync";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { calendarProject, savedPath } from "./calendarRouteFixture";
import { login, stackFor } from "./helpers";

registerCoverageHooks();

test("a real old room acquisition completing last cannot overwrite the newer Calendar route",
    async ({ page }, info) => {
        const stack = stackFor(info);
        await stack.start();
        try {
            const old = calendarProject("race-old", "Old project", "old-calendar", "Old Calendar");
            const newer = calendarProject("race-new", "New project", "new-calendar", "New Calendar");
            await stack.seedProjectDocument("race-old", "Old project", old.doc);
            await stack.seedProjectDocument("race-new", "New project", newer.doc);
            await login(page, stack);
            await page.goto(`${stack.origin}${savedPath("race-old", "old-calendar")}`);
            await expect(page.getByRole("heading", { name: "Old Calendar", exact: true })).toBeVisible();
            // Build real SvelteKit history using application links. Leaving the saved
            // route releases its acquired client; returning must acquire it again.
            await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Home", exact: true })
                .click();
            await page.locator("select.project-select").selectOption("race-new");
            await expect(page).toHaveURL(`${stack.origin}/New%20project`);
            await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
            await page.getByRole("link", { name: "Object Manager", exact: true }).click();
            await page.getByTestId("object-open-new-calendar").click();
            await expect(page.getByRole("heading", { name: "New Calendar", exact: true })).toBeVisible();

            let releaseOld: (() => void) | undefined;
            let oldClosed = false;
            let heldSnapshots = 0;
            let oldAuthorized = false;
            await page.routeWebSocket("**/projects/race-old", socket => {
                const server = socket.connectToServer();
                const queued: (string | Buffer)[] = [];
                let released = false;
                // Complete real session/room authentication, withholding only the
                // genuine initial document snapshot that completes acquisition.
                socket.onMessage(message => server.send(message));
                server.onMessage(message => {
                    const decoder = createDecoder(typeof message === "string" ? Buffer.from(message) : message);
                    expect(readVarString(decoder)).toBe("projects/race-old");
                    const type = readVarUint(decoder);
                    if (type === MessageType.Auth) {
                        oldAuthorized ||= readVarUint(decoder) === AuthMessageType.Authenticated;
                    }
                    if (!released && (type === MessageType.Sync || type === MessageType.SyncStatus)) {
                        queued.push(message);
                        if (type === MessageType.Sync && readVarUint(decoder) === messageYjsSyncStep2) heldSnapshots++;
                    } else socket.send(message);
                });
                socket.onClose(() => {
                    oldClosed = true;
                });
                releaseOld = () => {
                    released = true;
                    for (const message of queued) socket.send(message);
                };
            });
            for (let i = 0; i < 4; i++) await page.goBack();
            await expect(page).toHaveURL(`${stack.origin}${savedPath("race-old", "old-calendar")}`);
            await expect.poll(() => Boolean(releaseOld)).toBe(true);
            await expect.poll(() => heldSnapshots).toBeGreaterThan(0);
            expect(oldAuthorized).toBe(true);
            await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
            for (let i = 0; i < 4; i++) await page.goForward();
            await expect(page.getByRole("heading", { name: "New Calendar", exact: true })).toBeVisible();
            releaseOld!();
            await expect.poll(() => oldClosed).toBe(true);
            await expect(page).toHaveURL(`${stack.origin}/New%20project/-/calendars/new-calendar`);
            await expect(page.getByRole("heading", { name: "New Calendar", exact: true })).toBeVisible();
            await expect(page.getByRole("heading", { name: "Calendar not found" })).toHaveCount(0);
            await expect(page.getByRole("heading", { name: "An error occurred" })).toHaveCount(0);
            if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) {
                await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
            }
            const sidebar = page.getByRole("complementary", { name: "Main Sidebar" });
            await expect(sidebar.getByRole("link", { name: /^New Calendar page(?: |$)/ })).toBeVisible();
            await expect(sidebar.getByRole("link", { name: /^Old Calendar page(?: |$)/ })).toHaveCount(0);
            // A further ordinary app navigation must still read the new Project,
            // rather than merely retain a previously painted heading.
            await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
                name: "Calendars",
                exact: true,
            }).click();
            await expect(page.locator('[data-calendar-id="new-calendar"]')).toHaveText("New Calendar");
            await expect(page.locator('[data-calendar-id="old-calendar"]')).toHaveCount(0);
        } finally {
            await page.close();
            await stack.stop();
        }
    });
