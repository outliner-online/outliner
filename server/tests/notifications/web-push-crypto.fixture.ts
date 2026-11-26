import { expect } from "chai";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import type { MobilePayloadV1 } from "../../../shared/src/notifications/mobile-payload.js";
import type { PushConfig } from "../../src/notifications/push-config.js";
import type { CapturedPushRequest } from "./web-push-transport.fixture.js";

export function receiverKeys() {
    const ecdh = createECDH("prime256v1");
    const publicKey = ecdh.generateKeys();
    const auth = Buffer.alloc(16, 7);
    return { ecdh, publicKey, auth };
}
export type ReceiverKeys = ReturnType<typeof receiverKeys>;

/** Independent RFC 8291 receiver; the sending SDK is not used to decrypt its own output. */
export function decryptPush(request: CapturedPushRequest, receiver: ReceiverKeys): {
    payload: MobilePayloadV1;
    plaintext: Buffer;
} {
    const body = request.body;
    const salt = body.subarray(0, 16);
    const recordSize = body.readUInt32BE(16);
    const keyLength = body[20];
    expect(keyLength).to.equal(65);
    const senderPublic = body.subarray(21, 21 + keyLength);
    const secret = receiver.ecdh.computeSecret(senderPublic);
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.publicKey, senderPublic]);
    const ikm = hkdfSync("sha256", secret, receiver.auth, info, 32);
    const key = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
    const encrypted = body.subarray(21 + keyLength);
    expect(encrypted.length).to.be.lessThan(recordSize);
    const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
    decipher.setAuthTag(encrypted.subarray(-16));
    const padded = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    let delimiter = padded.length - 1;
    while (padded[delimiter] === 0) delimiter--;
    expect(padded[delimiter]).to.equal(2);
    const plaintext = padded.subarray(0, delimiter);
    return { payload: JSON.parse(plaintext.toString("utf8")), plaintext };
}

export function verifyVapid(request: CapturedPushRequest, config: PushConfig): void {
    const headers = request.options.headers as Record<string, string>;
    const authorization = headers.authorization;
    const parsed = /^vapid t=([^, ]+),\s*k=([^, ]+)$/u.exec(authorization);
    expect(parsed, "VAPID request authorization").not.to.equal(null);
    const [, jwt, key] = parsed!;
    expect(key).to.equal(config.publicKey);
    const [header, body, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).to.include({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(claims).to.include({ aud: `https://${request.options.hostname}`, sub: config.subject });
    expect(claims.exp).to.be.greaterThan(Math.floor(Date.now() / 1000));
    const bytes = Buffer.from(config.publicKey, "base64url");
    const publicKey = createPublicKey({
        format: "jwk",
        key: {
            kty: "EC",
            crv: "P-256",
            x: bytes.subarray(1, 33).toString("base64url"),
            y: bytes.subarray(33).toString("base64url"),
        },
    });
    expect(verify("sha256", Buffer.from(`${header}.${body}`), {
        key: publicKey,
        dsaEncoding: "ieee-p1363",
    }, Buffer.from(signature, "base64url"))).to.equal(true);
}
