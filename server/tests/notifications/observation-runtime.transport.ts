import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { createNotificationHttpsSender, type HttpsSendOutcome } from "../../src/notifications/https-transport.js";
import type { PreparedViewChange } from "../../src/notifications/prepared-view-change.js";

/** The real transport decides writeInitiated; this boundary only observes its first end(body). */
export function observedTransport(options: {
    beforeRevalidate?: () => Promise<void>;
    afterRevalidate?: () => Promise<void>;
    beforeWrite?: () => void;
    holdResponse?: boolean;
    responseStatus?: number;
} = {}) {
    const bodies: Buffer[] = [];
    let response: EventEmitter | undefined;
    class Socket extends EventEmitter {
        authorized = true;
        remoteAddress = "8.8.8.8";
        remotePort = 443;
        destroy() {
            return this;
        }
    }
    class Response extends EventEmitter {
        statusCode = options.responseStatus ?? 204;
        destroy() {
            return this;
        }
    }
    class Request extends EventEmitter {
        end(body: Buffer) {
            bodies.push(Buffer.from(body));
            response = new Response();
            this.emit("response", response);
            if (!options.holdResponse) queueMicrotask(() => response!.emit("end"));
            return this;
        }
        destroy() {
            return this;
        }
    }
    const socket = new Socket();
    const send = createNotificationHttpsSender({
        resolve4: async () => ["8.8.8.8"],
        connectTls: () => {
            queueMicrotask(() => socket.emit("secureConnect"));
            return socket as unknown as TLSSocket;
        },
        requestHttps: ((_: unknown, callback: (response: IncomingMessage) => void) => {
            const request = new Request();
            request.once("response", callback);
            options.beforeWrite?.();
            return request as unknown as ClientRequest;
        }) as typeof import("node:https").request,
    });
    return {
        bodies,
        finishResponse() {
            response!.emit("end");
        },
        async dispatch(candidate: PreparedViewChange): Promise<HttpsSendOutcome> {
            const body = Buffer.from(JSON.stringify({ eventId: candidate.eventId, summary: candidate.summary }));
            return send({
                url: "https://events.example.com/callback",
                headerProfile: "mcp-events",
                responseMode: "status",
                authorizationDeadlineMs: Date.now() + 15_000,
                canStart: () => true,
                beforeSend: async () => {
                    await options.beforeRevalidate?.();
                    const checked = await candidate.revalidate();
                    if (checked.status !== "current") return null;
                    await options.afterRevalidate?.();
                    return {
                        body,
                        headers: { "content-type": "application/json" },
                        isCurrent: checked.candidate.isCurrent,
                    };
                },
            });
        },
    };
}

export function settleTransport(candidate: PreparedViewChange, result: HttpsSendOutcome) {
    candidate.settleAttempt({
        initiated: result.writeInitiated,
        outcome: result.kind === "accepted" ? "accepted" : result.kind === "unknown" ? "unknown" : "failed",
    });
}
