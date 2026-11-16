import { expect, test } from "@playwright/test";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { createProject, login, stackFor } from "./helpers";
registerCoverageHooks();

test("uncontrolled cleanup waits for the real browser terminal callback", async ({ browser }, testInfo) => {
    const stack = stackFor(testInfo);
    const context = await browser.newContext();
    const target = await context.newPage();
    await stack.start();
    try {
        await login(target, stack);
        await createProject(target, `Uncontrolled-terminal-${Date.now()}`);
        await target.getByLabel("New page name").fill("Live target");
        await target.getByRole("button", { name: "Create new page" }).click();
        await expect(target).toHaveURL(/\/Live%20target$/);
        const tunnel = stack.transportSnapshot().filter(event => event.kind === "ws-open").slice(-1)[0]!;
        await stack.waitForTransportEvent("ws-upstream-data", tunnel.url, { id: tunnel.id });

        // Do not select a controlled terminal order. Delay only delivery of the
        // exact real client callback so upstream-first cleanup cannot race it.
        const held = stack.holdTunnelTerminalCallback(tunnel.id, "ws-client-close");
        const upstream = stack.waitForTransportEvent("ws-upstream-close", tunnel.url, { id: tunnel.id });
        // held.observed also accepts a real error callback; it does not prove
        // either native close callback has reached the independent recorder.
        const rawClientClose = stack.waitForTransportEvent("ws-client-socket-close", tunnel.url, { id: tunnel.id });
        const rawUpstreamClose = stack.waitForTransportEvent("ws-upstream-socket-close", tunnel.url, { id: tunnel.id });
        await target.close();
        await Promise.all([held.observed, upstream, rawClientClose, rawUpstreamClose]).finally(async () => {
            await testInfo.attach("uncontrolled-terminal-provenance", {
                contentType: "application/json",
                body: JSON.stringify({ id: tunnel.id, observations: stack.tunnelSocketSnapshot(tunnel.id) }),
            });
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(stack.isTunnelOpen(tunnel.id)).toBe(true);
        expect(stack.transportSnapshot().some(event => event.id === tunnel.id && event.kind === "ws-cleanup-complete"))
            .toBe(false);
        const observations = stack.tunnelSocketSnapshot(tunnel.id)!;
        expect(observations.some(event => event.side === "client" && event.event === "close")).toBe(true);
        expect(observations.some(event => event.side === "upstream" && event.event === "close")).toBe(true);
        expect(observations.every(event => !event.clientDestroyedByCleanup && !event.upstreamDestroyedByCleanup)).toBe(
            true,
        );
        const cleanup = stack.waitForTransportEvent("ws-cleanup-complete", tunnel.url, { id: tunnel.id });
        held.release();
        await cleanup;
        expect(stack.isTunnelOpen(tunnel.id)).toBe(false);
        expect(stack.transportSnapshot().filter(event =>
            event.id === tunnel.id
            && ["ws-upstream-close", "ws-client-close", "ws-cleanup-complete"].includes(event.kind)
        ).map(event => event.kind)).toEqual([
            "ws-upstream-close",
            "ws-client-close",
            "ws-cleanup-complete",
        ]);
    } finally {
        await context.close();
        await stack.stop();
    }
});
