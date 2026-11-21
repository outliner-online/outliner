import { resolve4 } from "node:dns/promises";
import type { ClientRequest } from "node:http";
import https from "node:https";
import tls, { type TLSSocket } from "node:tls";
import { isPublicIpv4, validateHttpsDestination, validateResolvedIpv4 } from "./https-destination.js";

const MAX_BODY = 16 * 1024;
const MAX_RESPONSE = 64 * 1024;
const MAX_ATTEMPT_MS = 10_000;

export type HeaderProfile = "mcp-events" | "web-push";
export type PreparedNotification = Readonly<{
    body: Uint8Array;
    headers: Readonly<Record<string, string>>;
    isCurrent: () => boolean;
}>;
export type HttpsPost = Readonly<{
    url: string;
    headerProfile: HeaderProfile;
    responseMode: "status" | "bounded-body";
    authorizationDeadlineMs: number;
    signal?: AbortSignal;
    canStart: () => boolean;
    beforeSend: () => Promise<PreparedNotification | null>;
}>;
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

function terminalReason(signal: AbortSignal | undefined, deadline: number): "cancelled" | "deadline" | undefined {
    return signal?.aborted ? "cancelled" : Date.now() >= deadline ? "deadline" : undefined;
}

export async function sendNotificationHttps(input: HttpsPost): Promise<HttpsSendOutcome> {
    const destination = validateHttpsDestination(input.url);
    if (!destination) return { kind: "rejected", reason: "destination", writeInitiated: false };
    const deadline = Math.min(Date.now() + MAX_ATTEMPT_MS, input.authorizationDeadlineMs);
    if (!input.canStart()) return { kind: "rejected", reason: "authorization", writeInitiated: false };
    let socket: TLSSocket | undefined;
    let request: ClientRequest | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    let writeInitiated = false;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
        const expired = terminalReason(input.signal, deadline);
        if (expired) return { kind: "unknown", reason: expired, writeInitiated };
        const answers = await Promise.race([
            resolve4(destination.hostname),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline")), remaining()).unref()),
        ]);
        const addresses = validateResolvedIpv4(answers);
        if (!addresses) return { kind: "rejected", reason: "destination", writeInitiated };
        const address = addresses[0];
        socket = await new Promise<TLSSocket>((resolve, reject) => {
            const candidate = tls.connect({
                host: address,
                port: 443,
                servername: destination.hostname,
                rejectUnauthorized: true,
            });
            const timer = setTimeout(() => candidate.destroy(new Error("deadline")), remaining()).unref();
            const abort = () => candidate.destroy(new Error("cancelled"));
            input.signal?.addEventListener("abort", abort, { once: true });
            candidate.once("secureConnect", () => {
                clearTimeout(timer);
                input.signal?.removeEventListener("abort", abort);
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
        });
        if (terminalReason(input.signal, deadline)) throw new Error("deadline");
        let prepared: PreparedNotification | null;
        try {
            prepared = await input.beforeSend();
        } catch {
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
                callback: (error: Error | null, stream?: import("node:stream").Duplex) => void,
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
        const agent = new PinnedAgent({ keepAlive: false, maxSockets: 1 });
        const outcome = await new Promise<HttpsSendOutcome>((resolve) => {
            const finish = (value: HttpsSendOutcome) => resolve(value);
            request = https.request({
                protocol: "https:",
                hostname: destination.hostname,
                port: 443,
                path: destination.path,
                method: "POST",
                headers: { ...headers, host: destination.hostname, "content-length": String(body.byteLength) },
                agent,
                timeout: remaining(),
            }, (incoming) => {
                response = incoming;
                const chunks: Buffer[] = [];
                let size = 0;
                incoming.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE) incoming.destroy(new Error("response-too-large"));
                    else if (input.responseMode === "bounded-body") chunks.push(Buffer.from(chunk));
                });
                incoming.on("end", () => {
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
            request.once("timeout", () => request?.destroy(new Error("deadline")));
            request.once("error", () =>
                finish({
                    kind: "unknown",
                    reason: terminalReason(input.signal, deadline) ?? "transport",
                    writeInitiated,
                }));
            // This is the deliberately synchronous authorization-to-first-write boundary.
            const stopped = terminalReason(input.signal, deadline);
            if (stopped || !prepared.isCurrent()) {
                request.destroy();
                finish(
                    stopped
                        ? { kind: "unknown", reason: stopped, writeInitiated }
                        : { kind: "rejected", reason: "authorization", writeInitiated },
                );
                return;
            }
            writeInitiated = true;
            request.end(body);
        });
        agent.destroy();
        return outcome;
    } catch (error) {
        const text = error instanceof Error ? error.message : "";
        const reason = terminalReason(input.signal, deadline) ?? (text === "deadline" ? "deadline" : undefined);
        return reason
            ? { kind: "unknown", reason, writeInitiated }
            : { kind: "rejected", reason: "tls", writeInitiated };
    } finally {
        response?.destroy();
        request?.destroy();
        socket?.destroy();
    }
}
