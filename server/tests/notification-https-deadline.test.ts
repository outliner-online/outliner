import { expect } from "chai";
import { createNotificationHttpsSender } from "../src/notifications/https-transport.js";

describe("notification HTTPS absolute deadline", () => {
    it("does not settle held DNS before the fixed authorization deadline", async function() {
        this.timeout(15_000);
        // Hold only the network boundary. The production timer and wall clock remain real.
        const send = createNotificationHttpsSender({
            resolve4: () => new Promise<string[]>(() => {}),
            connectTls: () => {
                throw new Error("TLS must not start while DNS is unresolved");
            },
            requestHttps: () => {
                throw new Error("An HTTP request must not start while DNS is unresolved");
            },
        });
        for (let attempt = 0; attempt < 100; attempt++) {
            const deadline = Date.now() + 80;
            const outcome = await send({
                url: "https://events.example.com/callback",
                headerProfile: "mcp-events",
                responseMode: "status",
                authorizationDeadlineMs: deadline,
                canStart: () => true,
                beforeSend: async () => {
                    throw new Error("No payload may be prepared while DNS is unresolved");
                },
            });
            const settledAt = Date.now();
            expect(outcome).to.deep.equal({ kind: "unknown", reason: "deadline", writeInitiated: false });
            expect(settledAt, `attempt ${attempt} settled before its absolute deadline`).to.be.at.least(deadline);
        }
    });
});
