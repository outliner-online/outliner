import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import {
    createNotificationHttpsSender,
    type HttpsPost,
    type HttpsSendOutcome,
} from "../../src/notifications/https-transport.js";

export interface CapturedPushRequest {
    readonly options: RequestOptions;
    readonly body: Buffer;
}
export interface PushTransportControls {
    beforeAuthorize?: (input: HttpsPost, index: number) => Promise<void>;
    afterAuthorize?: (input: HttpsPost, index: number) => Promise<void>;
    beforeWrite?: (options: RequestOptions) => void;
    response?: (request: CapturedPushRequest) => number | "unknown" | Promise<number | "unknown">;
}

/** Only DNS/TLS/HTTP primitives are controlled; production transport owns all gates and first writes. */
export function capturePushTransport(controls: PushTransportControls = {}) {
    const requests: CapturedPushRequest[] = [];
    const calls: string[] = [];
    const outcomes: HttpsSendOutcome[] = [];
    class Socket extends EventEmitter {
        authorized = true;
        remoteAddress = "8.8.8.8";
        remotePort = 443;
        destroy() {
            return this;
        }
    }
    class Response extends EventEmitter {
        constructor(readonly statusCode: number) {
            super();
        }
        destroy() {
            return this;
        }
    }
    class Request extends EventEmitter {
        destroyed = false;
        constructor(readonly options: RequestOptions, readonly callback: (response: IncomingMessage) => void) {
            super();
        }
        end(body: Buffer) {
            const captured = { options: this.options, body: Buffer.from(body) };
            requests.push(captured);
            Promise.resolve(controls.response?.(captured) ?? 201).then(status => {
                if (this.destroyed) return;
                if (status === "unknown") {
                    this.emit("error", new Error("controlled provider closed after receiving body"));
                    return;
                }
                const response = new Response(status);
                this.callback(response as unknown as IncomingMessage);
                queueMicrotask(() => response.emit("end"));
            }).catch(() => this.emit("error", new Error("controlled provider failure")));
            return this;
        }
        destroy() {
            this.destroyed = true;
            return this;
        }
    }
    const send = createNotificationHttpsSender({
        resolve4: async () => ["8.8.8.8"],
        connectTls: () => {
            const socket = new Socket();
            queueMicrotask(() => socket.emit("secureConnect"));
            return socket as unknown as TLSSocket;
        },
        requestHttps: ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
            controls.beforeWrite?.(options);
            return new Request(options, callback) as unknown as ClientRequest;
        }) as typeof import("node:https").request,
    });
    return {
        requests,
        calls,
        outcomes,
        async transport(input: HttpsPost): Promise<HttpsSendOutcome> {
            const index = calls.push(input.url) - 1;
            const result = await send({
                ...input,
                beforeSend: async () => {
                    await controls.beforeAuthorize?.(input, index);
                    const prepared = await input.beforeSend();
                    await controls.afterAuthorize?.(input, index);
                    return prepared;
                },
            });
            outcomes.push(result);
            return result;
        },
    };
}
