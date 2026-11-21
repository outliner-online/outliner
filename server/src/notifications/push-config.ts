import { createHash } from "node:crypto";

export interface PushConfig {
    publicKey: string;
    privateKey: string;
    subject: string;
    vapidKeyId: string;
}

function decode(value: string): Buffer | undefined {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
    try {
        return Buffer.from(value, "base64url");
    } catch {
        return undefined;
    }
}

/** Load a stable operator-owned VAPID identity. Keys are never generated here. */
export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig | undefined {
    const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const subject = env.WEB_PUSH_VAPID_SUBJECT;
    const publicBytes = publicKey ? decode(publicKey) : undefined;
    const privateBytes = privateKey ? decode(privateKey) : undefined;
    if (
        !publicKey || !privateKey || !subject || publicBytes?.length !== 65 || publicBytes[0] !== 4
        || privateBytes?.length !== 32 || !/^(mailto:|https:\/\/)/u.test(subject)
    ) return undefined;
    return { publicKey, privateKey, subject, vapidKeyId: createHash("sha256").update(publicBytes).digest("base64url") };
}
