import { expect, test } from "@playwright/test";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { createProject, login, stackFor } from "./helpers";
registerCoverageHooks();

test("an interrupted real browser tunnel forwards termination before held callback delivery",
    async ({ browser }, testInfo) => {
        const stack = stackFor(testInfo);
        const context = await browser.newContext();
        const target = await context.newPage();
        await stack.start();
        try {
            await login(target, stack);
            await createProject(target, `Interrupted-tunnel-${Date.now()}`);
            await target.getByLabel("New page name").fill("Live target");
            await target.getByRole("button", { name: "Create new page" }).click();
            await expect(target).toHaveURL(/\/Live%20target$/);
            const tunnel = stack.transportSnapshot().filter(event => event.kind === "ws-open").slice(-1)[0]!;
            await stack.waitForTransportEvent("ws-upstream-data", tunnel.url, { id: tunnel.id });
            stack.controlTunnelTerminalOrder(tunnel.id, "ws-upstream-close");
            const held = stack.holdTunnelTerminalCallback(tunnel.id, "ws-client-close");
            const first = stack.waitForTransportEvent("ws-upstream-close", tunnel.url, { id: tunnel.id });

            // Explicit fixture-origin network fault on the actual browser tunnel.
            // This is not evidence of the historical CI initiating event. No fake
            // socket callback or backend terminal observation is injected.
            stack.interruptTunnelClient(tunnel.id);
            await target.close();
            await Promise.all([held.observed, first]).finally(async () => {
                await testInfo.attach("exact-interrupted-tunnel-socket-provenance", {
                    contentType: "application/json",
                    body: JSON.stringify({ id: tunnel.id, observations: stack.tunnelSocketSnapshot(tunnel.id) }),
                });
            });
            const observations = stack.tunnelSocketSnapshot(tunnel.id)!;
            expect(observations.some(event => event.side === "client" && event.event === "end")).toBe(false);
            expect(observations.some(event => event.side === "client" && event.event === "close")).toBe(true);
            expect(observations.some(event =>
                event.side === "upstream" && event.event === "close"
                && !event.clientDestroyedByCleanup && !event.upstreamDestroyedByCleanup
            )).toBe(true);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(stack.isTunnelOpen(tunnel.id)).toBe(true);
            expect(
                stack.transportSnapshot().some(event => event.id === tunnel.id && event.kind === "ws-cleanup-complete"),
            ).toBe(false);
            const cleanup = stack.waitForTransportEvent("ws-cleanup-complete", tunnel.url, { id: tunnel.id });
            held.release();
            await cleanup;
            expect(stack.isTunnelOpen(tunnel.id)).toBe(false);
            expect(stack.transportSnapshot().filter(event =>
                event.id === tunnel.id
                && ["ws-client-reset-request", "ws-upstream-close", "ws-client-close", "ws-cleanup-complete"].includes(
                    event.kind,
                )
            ).map(event => event.kind)).toEqual([
                "ws-client-reset-request",
                "ws-upstream-close",
                "ws-client-close",
                "ws-cleanup-complete",
            ]);
        } finally {
            await context.close();
            await stack.stop();
        }
    });
