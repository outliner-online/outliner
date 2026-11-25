import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Separate notification credential key: exactly 32 bytes encoded as base64. */
export class CredentialEnvelope {
    private readonly key: Buffer;
    constructor(encoded: string) {
        this.key = Buffer.from(encoded, "base64");
        if (this.key.length !== 32 || this.key.toString("base64") !== encoded) {
            throw new Error("notification credentials unavailable");
        }
    }
    seal(value: unknown, context: string): string {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        cipher.setAAD(Buffer.from(context));
        const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
        return JSON.stringify([1, nonce.toString("base64"), cipher.getAuthTag().toString("base64"),
            bytes.toString("base64")]);
    }
    open<T>(sealed: string, context: string): T {
        try {
            const [version, nonce, tag, bytes] = JSON.parse(sealed);
            if (version !== 1) throw new Error();
            const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce, "base64"));
            cipher.setAAD(Buffer.from(context));
            cipher.setAuthTag(Buffer.from(tag, "base64"));
            return JSON.parse(Buffer.concat([cipher.update(Buffer.from(bytes, "base64")), cipher.final()]).toString());
        } catch {
            throw new Error("notification credentials unavailable");
        }
    }
}
