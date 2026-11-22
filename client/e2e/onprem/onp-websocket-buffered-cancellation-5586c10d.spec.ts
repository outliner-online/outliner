import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { createProject, login, stackFor } from "./helpers";
registerCoverageHooks();

test("a reset drains buffered upstream data to native close while the authenticated peer stays live",
    async ({ browser }, testInfo) => {
        const stack = stackFor(testInfo);
        const targetContext = await browser.newContext();
        const peerContext = await browser.newContext();
        const observerContext = await browser.newContext();
        const target = await targetContext.newPage();
        const peer = await peerContext.newPage();
        await stack.start();
        try {
            await login(target, stack);
            await createProject(target, `Buffered-target-${Date.now()}`);
            await target.getByLabel("New page name").fill("Live target");
            await target.getByRole("button", { name: "Create new page" }).click();
            await expect(target).toHaveURL(/\/Live%20target$/);
            const tunnel = stack.transportSnapshot().filter(event => event.kind === "ws-open").slice(-1)[0]!;
            await stack.waitForTransportEvent("ws-upstream-data", tunnel.url, { id: tunnel.id });

            await login(peer, stack);
            await peer.goto(target.url());
            await expect(peer.getByTestId("outliner-base")).toBeVisible();
            const peerTunnel = stack.transportSnapshot().filter(event =>
                event.kind === "ws-open" && event.url === tunnel.url && event.id !== tunnel.id
            ).slice(-1)[0]!;
            await stack.waitForTransportEvent("ws-upstream-data", peerTunnel.url, { id: peerTunnel.id });
            const additionalPeerRooms: string[] = [];
            peer.on("websocket", socket => additionalPeerRooms.push(new URL(socket.url()).pathname));

            // Model the paused reader left by pipe() when its destination closes.
            // Real edits on the other authenticated owner supply unread bytes.
            const bufferedBytes = stack.pauseTunnelUpstreamReads(tunnel.id);
            await peer.getByTestId("add-item-button").click();
            await peer.getByTestId("outliner-base").locator(".outliner-item[data-item-id]").nth(1).click();
            await peer.keyboard.type("Buffered real peer update");
            await peer.keyboard.press("Enter");
            await expect.poll(bufferedBytes, { timeout: 15_000 }).toBeGreaterThan(0);
            expect(stack.isTunnelOpen(peerTunnel.id)).toBe(true);

            const held = stack.holdTunnelTerminalCallback(tunnel.id, "ws-upstream-close");
            const clientClosed = stack.waitForTransportEvent("ws-client-close", tunnel.url, { id: tunnel.id });
            stack.interruptTunnelClient(tunnel.id);
            await target.close();
            await Promise.all([clientClosed, held.observed]).finally(async () => {
                await testInfo.attach("buffered-target-terminal-provenance", {
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: tunnel.id,
                        peerId: peerTunnel.id,
                        observations: stack.tunnelSocketSnapshot(tunnel.id),
                    }),
                });
            });
            const observations = stack.tunnelSocketSnapshot(tunnel.id)!;
            for (const side of ["client", "upstream"]) {
                expect(observations.some(event => event.side === side && event.event === "close")).toBe(true);
            }
            expect(observations.every(event => !event.clientDestroyedByCleanup && !event.upstreamDestroyedByCleanup))
                .toBe(true);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(stack.isTunnelOpen(tunnel.id)).toBe(true);
            expect(
                stack.transportSnapshot().some(event => event.id === tunnel.id && event.kind === "ws-cleanup-complete"),
            ).toBe(false);
            const cleanup = stack.waitForTransportEvent("ws-cleanup-complete", tunnel.url, { id: tunnel.id });
            held.release();
            await cleanup;
            expect(stack.isTunnelOpen(tunnel.id)).toBe(false);
            expect(stack.isTunnelOpen(peerTunnel.id)).toBe(true);
            expect(stack.transportSnapshot().some(event => event.id === peerTunnel.id && event.kind.includes("close")))
                .toBe(false);

            stack.clearTransportEvents();
            const marker = `Same peer after target cleanup ${randomUUID()}`;
            await peer.keyboard.type(marker);
            await peer.keyboard.press("Enter");
            await peer.keyboard.type("Backend round trip");
            await peer.keyboard.press("Enter");
            await expect(peer.getByText(marker, { exact: true })).toBeVisible();
            await stack.waitForTransportEvent("ws-upstream-data", peerTunnel.url, { id: peerTunnel.id });
            // A fresh authenticated context must receive this edit from the
            // same backend; optimistic local text or unrelated bytes cannot pass.
            const observer = await observerContext.newPage();
            await login(observer, stack);
            const beforeObserver = stack.transportSnapshot().length;
            await observer.goto(peer.url());
            await expect.poll(() =>
                stack.transportSnapshot().slice(beforeObserver).find(event =>
                    event.kind === "ws-open" && event.url === peerTunnel.url
                )?.id
            ).not.toBeUndefined();
            const observerTunnel = stack.transportSnapshot().slice(beforeObserver).find(event =>
                event.kind === "ws-open" && event.url === peerTunnel.url
            )!;
            expect(observerTunnel.id).not.toBe(peerTunnel.id);
            const observerData = await stack.waitForTransportEvent("ws-upstream-data", observerTunnel.url, {
                id: observerTunnel.id,
                stage: "fresh authenticated observer backend data",
            });
            await expect(observer.getByText(marker, { exact: true })).toBeVisible({ timeout: 15_000 });
            expect(observerData.id).toBe(observerTunnel.id);
            expect(stack.isTunnelOpen(peerTunnel.id)).toBe(true);
            expect(stack.transportSnapshot().some(event => event.id === peerTunnel.id && event.kind.includes("close")))
                .toBe(false);
            expect(additionalPeerRooms.filter(room => room === new URL(peerTunnel.url, stack.origin).pathname))
                .toEqual([]);
        } finally {
            await targetContext.close();
            await observerContext.close();
            await peerContext.close();
            await stack.stop();
        }
    });
