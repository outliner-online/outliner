import Database from "better-sqlite3";
import { expect } from "chai";
import express from "express";
import { createECDH } from "node:crypto";
import request from "supertest";
import { createPushDeviceRouter } from "../../src/notifications/push-device-api.js";
import { PushDeviceStore } from "../../src/notifications/push-device-store.js";

const device = "browser_device_identifier_01";
const config = {
    publicKey: createECDH("prime256v1").generateKeys().toString("base64url"),
    privateKey: Buffer.alloc(32, 1).toString("base64url"),
    vapidKeyId: "configured-key",
    subject: "mailto:push@example.test",
};

function createApp(store: PushDeviceStore) {
    const app = express();
    app.use(express.json());
    app.use("/api", createPushDeviceRouter({
        store,
        config,
        verifyToken: async token => {
            if (!token.startsWith("token-")) throw new Error("invalid token");
            return { uid: token.slice(6) } as Awaited<
                ReturnType<NonNullable<Parameters<typeof createPushDeviceRouter>[0]["verifyToken"]>>
            >;
        },
    }));
    return app;
}

describe("authenticated Web Push device API", () => {
    it("commits and reconciles only the verified owner's registration", async () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const app = createApp(store);

        await request(app).get(`/api/notifications/push/devices/${device}`).expect(401);
        await request(app).get(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer invalid").expect(401);

        const admission = await request(app).post("/api/notifications/push/admissions")
            .set("Authorization", "Bearer token-owner-a").expect(200);
        const ecdh = createECDH("prime256v1");
        const registration = {
            uid: "owner-b",
            expectedRevision: 0,
            admissionFence: admission.body.admissionFence,
            enrollmentGeneration: "accepted_generation_0001",
            vapidKeyId: config.vapidKeyId,
            subscription: {
                endpoint: "https://push.example.test/send/api-integration",
                keys: {
                    p256dh: ecdh.generateKeys().toString("base64url"),
                    auth: Buffer.alloc(16, 7).toString("base64url"),
                },
            },
        };
        const committed = await request(app).put(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-a").send(registration).expect(200);
        expect(committed.body).to.include({ deviceId: device, revision: 1, state: "registered" });
        expect(committed.body).not.to.have.any.keys("endpoint", "p256dh", "auth", "enrollmentGeneration");

        const repeated = await request(app).put(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-a").send(registration).expect(200);
        expect(repeated.body).to.deep.equal(committed.body);
        const ownerB = await request(app).get(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-b").expect(200);
        expect(ownerB.body).to.include({ revision: 0, state: "disabled" });

        const invalidAdmission = await request(app).post("/api/notifications/push/admissions")
            .set("Authorization", "Bearer token-owner-a").expect(200);
        await request(app).put("/api/notifications/push/devices/another_device_identifier")
            .set("Authorization", "Bearer token-owner-a").send({
                ...registration,
                admissionFence: invalidAdmission.body.admissionFence,
                subscription: { ...registration.subscription, endpoint: "http://push.example.test/not-https" },
            }).expect(400);
        expect(store.list("owner-a")).to.have.length(1);

        const reopened = createApp(new PushDeviceStore(db));
        const persisted = await request(reopened).get(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-a").expect(200);
        expect(persisted.body).to.deep.equal(committed.body);
        await request(reopened).post(`/api/notifications/push/devices/${device}/disable`)
            .set("Authorization", "Bearer token-owner-a").expect(200)
            .expect(response => expect(response.body).to.include({ revision: 2, state: "disabled" }));
        expect(store.get("owner-a", device)).to.include({ revision: 2, state: "disabled" });
        db.close();
    });
});
