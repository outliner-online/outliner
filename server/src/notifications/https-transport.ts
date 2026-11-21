import { resolve4 } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import { isPublicIpv4, validateHttpsDestination, validateResolvedIpv4 } from "./https-destination.js";

const MAX_BODY = 16 * 1024;
const MAX_RESPONSE = 64 * 1024;
const MAX_ATTEMPT_MS = 10_000;

export type HeaderProfile = "mcp-events" | "web-push";
export type PreparedNotification = Readonly<
    { body: Uint8Array; headers: Readonly<Record<string, string>>; isCurrent: () => boolean; }
>;
export type HttpsPost = Readonly<
    {
        url: string;
        headerProfile: HeaderProfile;
        responseMode: "status" | "bounded-body";
        authorizationDeadlineMs: number;
        signal?: AbortSignal;
        canStart: () => boolean;
        beforeSend: () => Promise<PreparedNotification | null>;
    }
>;
export type HttpsSendOutcome =
    | { kind: "accepted"; status: number; responseBody?: Uint8Array; writeInitiated: true; }
    | {
        kind: "rejected";
        reason: "destination" | "headers" | "body" | "tls" | "redirect" | "authorization";
        status?: number;
        writeInitiated: boolean;
    }
    | { kind: "http_error"; status: number; writeInitiated: true; }
    | { kind: "unknown"; reason: "deadline" | "transport" | "cancelled"; writeInitiated: boolean; };

export type NotificationTransportDependencies = Readonly<{
    resolve4: (hostname: string) => Promise<string[]>;
    connectTls: (options: tls.ConnectionOptions) => TLSSocket;
    requestHttps: typeof https.request;
}>;
const NODE_DEPENDENCIES: NotificationTransportDependencies = {
    resolve4,
    connectTls: (options) => tls.connect(options),
    requestHttps: https.request,
};

const MCP_HEADERS = new Set(["content-type", "webhook-id", "webhook-timestamp", "webhook-signature",
    "x-mcp-subscription-id"]);
const PUSH_HEADERS = new Set(["content-type", "content-encoding", "ttl", "urgency", "topic", "encryption", "crypto-key",
    "authorization"]);
export function validateNotificationHeaders(
    profile: HeaderProfile,
    input: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
    const allowed = profile === "mcp-events" ? MCP_HEADERS : PUSH_HEADERS;
    const output: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(input)) {
        const name = rawName.toLowerCase();
        if (
            !allowed.has(name) || name in output || !/^[a-z0-9-]+$/iu.test(rawName) || /[\r\n\0]/u.test(value)
            || value.length > 4096
        ) return undefined;
        if (name === "authorization" && !/^vapid\s+/iu.test(value)) return undefined;
        output[name] = value;
    }
    return output;
}

class AttemptStopped extends Error {
    readonly reason: "deadline" | "cancelled";
    constructor(reason: "deadline" | "cancelled") {
        super(reason);
        this.reason = reason;
    }
}

export function createNotificationHttpsSender(dependencies: NotificationTransportDependencies) {
    return async function send(input: HttpsPost): Promise<HttpsSendOutcome> {
        const destination = validateHttpsDestination(input.url);
        if (!destination) return { kind: "rejected", reason: "destination", writeInitiated: false };
        if (!input.canStart()) return { kind: "rejected", reason: "authorization", writeInitiated: false };
        const deadline = Math.min(Date.now() + MAX_ATTEMPT_MS, input.authorizationDeadlineMs);
        let socket: TLSSocket | undefined;
        let request: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let agent: https.Agent | undefined;
        let writeInitiated = false;
        let stopReject!: (error: AttemptStopped) => void;
        const stopped = new Promise<never>((_, reject) => stopReject = reject);
        const stop = (reason: "deadline" | "cancelled") => {
            response?.destroy();
            request?.destroy();
            socket?.destroy();
            stopReject(new AttemptStopped(reason));
        };
        const timer = setTimeout(() => stop("deadline"), Math.max(0, deadline - Date.now())).unref();
        const onAbort = () => stop("cancelled");
        input.signal?.addEventListener("abort", onAbort, { once: true });
        const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stopped]);
        try {
            if (input.signal?.aborted) throw new AttemptStopped("cancelled");
            if (Date.now() >= deadline) throw new AttemptStopped("deadline");
            const answers = validateResolvedIpv4(await bounded(dependencies.resolve4(destination.hostname)));
            if (!answers) return { kind: "rejected", reason: "destination", writeInitiated };
            const address = answers[0];
            socket = await bounded(new Promise<TLSSocket>((resolve, reject) => {
                const candidate = dependencies.connectTls({
                    host: address,
                    port: 443,
                    servername: destination.hostname,
                    rejectUnauthorized: true,
                });
                socket = candidate;
                candidate.once("secureConnect", () => {
                    const peer = candidate.remoteAddress?.replace(/^::ffff:/u, "");
                    if (
                        !candidate.authorized || peer !== address || candidate.remotePort !== 443
                        || !isPublicIpv4(peer ?? "")
                    ) {
                        candidate.destroy();
                        reject(new Error("tls"));
                    } else resolve(candidate);
                });
                candidate.once("error", reject);
            }));
            let prepared: PreparedNotification | null;
            try {
                prepared = await bounded(input.beforeSend());
            } catch (error) {
                if (error instanceof AttemptStopped) throw error;
                return { kind: "rejected", reason: "authorization", writeInitiated };
            }
            if (!prepared) return { kind: "rejected", reason: "authorization", writeInitiated };
            const body = Buffer.from(prepared.body);
            if (body.byteLength > MAX_BODY) return { kind: "rejected", reason: "body", writeInitiated };
            const headers = validateNotificationHeaders(input.headerProfile, prepared.headers);
            if (!headers) return { kind: "rejected", reason: "headers", writeInitiated };
            class PinnedAgent extends https.Agent {
                #available = true;
                override createConnection(
                    _options: https.RequestOptions,
                    callback: (error: Error | null, stream?: Duplex) => void,
                ): TLSSocket {
                    if (!this.#available) {
                        const error = new Error("pinned socket already consumed");
                        callback(error);
                        throw error;
                    }
                    this.#available = false;
                    callback(null, socket!);
                    return socket!;
                }
            }
            agent = new PinnedAgent({ keepAlive: false, maxSockets: 1 });
            return await bounded(new Promise<HttpsSendOutcome>((resolve) => {
                let settled = false;
                const finish = (outcome: HttpsSendOutcome) => {
                    if (!settled) {
                        settled = true;
                        resolve(outcome);
                    }
                };
                request = dependencies.requestHttps({
                    protocol: "https:",
                    hostname: destination.hostname,
                    port: 443,
                    path: destination.path,
                    method: "POST",
                    headers: { ...headers, host: destination.hostname, "content-length": String(body.byteLength) },
                    agent,
                }, (incoming) => {
                    response = incoming;
                    const chunks: Buffer[] = [];
                    let size = 0;
                    incoming.on("data", (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > MAX_RESPONSE) {
                            finish({ kind: "unknown", reason: "transport", writeInitiated });
                            incoming.destroy(new Error("response-too-large"));
                        } else if (input.responseMode === "bounded-body") chunks.push(Buffer.from(chunk));
                    });
                    incoming.once("error", () => finish({ kind: "unknown", reason: "transport", writeInitiated }));
                    incoming.once("end", () => {
                        if (input.signal?.aborted || Date.now() >= deadline) {
                            finish({
                                kind: "unknown",
                                reason: input.signal?.aborted ? "cancelled" : "deadline",
                                writeInitiated,
                            });
                            return;
                        }
                        const status = incoming.statusCode ?? 0;
                        if (status >= 300 && status < 400) {
                            finish({ kind: "rejected", reason: "redirect", status, writeInitiated: true });
                        } else if (status >= 200 && status < 300) {
                            finish({
                                kind: "accepted",
                                status,
                                responseBody: input.responseMode === "bounded-body" ? Buffer.concat(chunks) : undefined,
                                writeInitiated: true,
                            });
                        } else finish({ kind: "http_error", status, writeInitiated: true });
                    });
                });
                request.once("error", () => finish({ kind: "unknown", reason: "transport", writeInitiated }));
                // No await or callback occurs between this guard and the first write initiation.
                if (input.signal?.aborted || Date.now() >= deadline || !prepared.isCurrent()) {
                    request.destroy();
                    finish(input.signal?.aborted || Date.now() >= deadline
                        ? { kind: "unknown", reason: input.signal?.aborted ? "cancelled" : "deadline", writeInitiated }
                        : { kind: "rejected", reason: "authorization", writeInitiated });
                    return;
                }
                writeInitiated = true;
                request.end(body);
            }));
        } catch (error) {
            if (error instanceof AttemptStopped) return { kind: "unknown", reason: error.reason, writeInitiated };
            return { kind: "rejected", reason: "tls", writeInitiated };
        } finally {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", onAbort);
            response?.destroy();
            request?.destroy();
            socket?.destroy();
            agent?.destroy();
        }
    };
}

export const sendNotificationHttps = createNotificationHttpsSender(NODE_DEPENDENCIES);
