import express from "express";
import { createECDH, createHash, randomBytes } from "node:crypto";
import request from "supertest";
import type { NotificationRule } from "../../../shared/src/notifications/notification-settings.js";
import type { ViewChangeAttemptOutcome } from "../../src/notifications/prepared-view-change.js";
import type { PushConfig } from "../../src/notifications/push-config.js";
import { createPushDeviceRouter } from "../../src/notifications/push-device-api.js";
import { PushDeviceStore } from "../../src/notifications/push-device-store.js";
import { WebPushDeliveryAdapter } from "../../src/notifications/web-push-delivery.js";
import { rule, runtimeFixture, type RuntimeOptions, UID } from "./observation-runtime.fixture.js";
import { receiverKeys } from "./web-push-crypto.fixture.js";
import { capturePushTransport, type PushTransportControls } from "./web-push-transport.fixture.js";

export function mobileRule(input: NotificationRule = rule()): NotificationRule {
    return { ...input, channels: { mcp: false, mobile: true } };
}
function pushConfig(): PushConfig {
    const ecdh = createECDH("prime256v1");
    const publicKey = ecdh.generateKeys();
    // ECDH omits leading zeroes; VAPID requires the fixed-width P-256 scalar.
    const scalar = ecdh.getPrivateKey();
    const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
    return {
        publicKey: publicKey.toString("base64url"),
        privateKey: privateKey.toString("base64url"),
        vapidKeyId: createHash("sha256").update(publicKey).digest("base64url"),
        subject: "mailto:push-tests@example.test",
    };
}

/** Actual live rooms, projections, runtime, SQLite enrollment, API, encryption and pinned sender. */
export async function webPushFixture(options: {
    transportControls?: PushTransportControls;
    runtimeOptions?: RuntimeOptions;
    directory?: string;
    config?: PushConfig;
} = {}) {
    const f = await runtimeFixture(options.runtimeOptions, {}, options.directory, false);
    const config = options.config ?? pushConfig();
    const store = new PushDeviceStore(f.server.persistence!.db!);
    store.initialize();
    const app = express();
    app.use(express.json());
    app.use("/api", createPushDeviceRouter({
        store,
        config,
        // Controlled Firebase-token verification boundary; ownership and writes remain production API logic.
        verifyToken: async token =>
            ({ uid: token }) as Awaited<
                ReturnType<NonNullable<Parameters<typeof createPushDeviceRouter>[0]["verifyToken"]>>
            >,
    }));
    const captured = capturePushTransport(options.transportControls);
    const settlements: ViewChangeAttemptOutcome[] = [];
    const adapter = new WebPushDeliveryAdapter(f.runtime, store, {
        config: () => config,
        transport: captured.transport,
        onResult: result => settlements.push(result),
    });
    const enroll = async (deviceId = "browser_device_identifier_a", uid = UID) => {
        const receiver = receiverKeys();
        const endpoint = `https://push.example.test/send/${deviceId}?opaque=preserved`;
        const enrollmentGeneration = randomBytes(24).toString("base64url");
        const admission = await request(app).post("/api/notifications/push/admissions")
            .set("Authorization", `Bearer ${uid}`).send({ deviceId }).expect(200);
        const committed = await request(app).put(`/api/notifications/push/devices/${deviceId}`)
            .set("Authorization", `Bearer ${uid}`).send({
                expectedRevision: store.get(uid, deviceId)?.revision ?? 0,
                admissionFence: admission.body.admissionFence,
                enrollmentGeneration,
                vapidKeyId: config.vapidKeyId,
                subscription: {
                    endpoint,
                    keys: {
                        p256dh: receiver.publicKey.toString("base64url"),
                        auth: receiver.auth.toString("base64url"),
                    },
                },
            }).expect(200);
        return {
            ...receiver,
            deviceId,
            uid,
            endpoint,
            enrollmentGeneration,
            revision: committed.body.revision as number,
        };
    };
    return {
        ...f,
        config,
        store,
        app,
        adapter,
        captured,
        settlements,
        enroll,
        async disable(deviceId: string, uid = UID) {
            await request(app).post(`/api/notifications/push/devices/${deviceId}/disable`)
                .set("Authorization", `Bearer ${uid}`).expect(200);
        },
        async close() {
            adapter.close();
            await f.close();
        },
    };
}
export type WebPushFixture = Awaited<ReturnType<typeof webPushFixture>>;
