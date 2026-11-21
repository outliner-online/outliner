import { randomBytes, randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { type HttpsPost, sendNotificationHttps } from "./https-transport.js";

export type SignedMcpWebhook = Readonly<{
    body: Uint8Array;
    headers: Readonly<Record<string, string>>;
}>;

function signingWebhook(secret: string): Webhook {
    if (!/^whsec_[A-Za-z0-9+/=_-]{16,}$/u.test(secret)) throw new Error("invalid signing secret");
    try {
        return new Webhook(secret);
    } catch {
        throw new Error("invalid signing secret");
    }
}

export function signMcpWebhook(input: {
    body: unknown;
    eventId: string;
    subscriptionId: string;
    secret: string;
    timestampMs: number;
}): SignedMcpWebhook {
    if (!input.eventId || !input.subscriptionId || !Number.isFinite(input.timestampMs)) {
        throw new Error("invalid webhook metadata");
    }
    const body = Buffer.from(JSON.stringify(input.body));
    const timestamp = new Date(input.timestampMs);
    const signature = signingWebhook(input.secret).sign(input.eventId, timestamp, body);
    return Object.freeze({
        body,
        headers: Object.freeze({
            "content-type": "application/json",
            "webhook-id": input.eventId,
            "webhook-timestamp": String(Math.floor(input.timestampMs / 1000)),
            "webhook-signature": signature,
            "x-mcp-subscription-id": input.subscriptionId,
        }),
    });
}

export type VerifyMcpCallbackInput = Readonly<{
    url: string;
    subscriptionId: string;
    secret: string;
    authorizationDeadlineMs: number;
    canStart: () => boolean;
    revalidate: () => Promise<null | { isCurrent: () => boolean; }>;
    signal?: AbortSignal;
}>;

export async function verifyMcpCallback(input: VerifyMcpCallbackInput): Promise<
    { kind: "verified"; } | { kind: "failed" | "unknown"; reason: string; }
> {
    const challenge = randomBytes(32).toString("base64url");
    const post: HttpsPost = {
        url: input.url,
        headerProfile: "mcp-events",
        responseMode: "bounded-body",
        authorizationDeadlineMs: input.authorizationDeadlineMs,
        signal: input.signal,
        canStart: input.canStart,
        beforeSend: async () => {
            const authority = await input.revalidate();
            if (!authority) return null;
            const signed = signMcpWebhook({
                body: { challenge },
                eventId: randomUUID(),
                subscriptionId: input.subscriptionId,
                secret: input.secret,
                timestampMs: Date.now(),
            });
            return { ...signed, isCurrent: authority.isCurrent };
        },
    };
    const outcome = await sendNotificationHttps(post);
    if (outcome.kind === "unknown") return { kind: "unknown", reason: outcome.reason };
    if (outcome.kind !== "accepted" || !outcome.responseBody) return { kind: "failed", reason: outcome.kind };
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(outcome.responseBody);
        const decoded: unknown = JSON.parse(text);
        if (
            typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
            && (decoded as { challenge?: unknown; }).challenge === challenge
        ) {
            return { kind: "verified" };
        }
    } catch {
        // Public results intentionally do not expose response bytes or parser exceptions.
    }
    return { kind: "failed", reason: "challenge" };
}
