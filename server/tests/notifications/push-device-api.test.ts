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

        const admission = await request(app).post("/api/notifications/push/admissions").send({ deviceId: device })
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
        expect(committed.body).to.include({
            deviceId: device,
            revision: 1,
            state: "registered",
            enrollmentGeneration: "accepted_generation_0001",
        });
        expect(committed.body).not.to.have.any.keys("endpoint", "p256dh", "auth");

        const renewalAdmission = await request(app).post("/api/notifications/push/admissions").send({
            deviceId: device,
        })
            .set("Authorization", "Bearer token-owner-a").expect(200);
        const repeated = await request(app).put(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-a").send({
                ...registration,
                expectedRevision: 1,
                admissionFence: renewalAdmission.body.admissionFence,
                enrollmentGeneration: "uncommitted_generation_0002",
            }).expect(200);
        expect(repeated.body).to.include({
            revision: 2,
            state: "registered",
            enrollmentGeneration: "uncommitted_generation_0002",
        });
        const ownerB = await request(app).get(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-b").expect(200);
        expect(ownerB.body).to.include({ revision: 0, state: "disabled" });

        const invalidAdmission = await request(app).post("/api/notifications/push/admissions").send({
            deviceId: device,
        })
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
        expect(persisted.body).to.deep.equal(repeated.body);
        await request(reopened).post(`/api/notifications/push/devices/${device}/disable`)
            .set("Authorization", "Bearer token-owner-a").expect(200)
            .expect(response => expect(response.body).to.include({ revision: 3, state: "disabled" }));
        expect(store.get("owner-a", device)).to.include({ revision: 3, state: "disabled" });
        db.close();
    });

    it("lets authenticated disable overtake admitted first registration authority", async () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const app = createApp(store);
        const admission = await request(app).post("/api/notifications/push/admissions").send({ deviceId: device })
            .set("Authorization", "Bearer token-owner-a").expect(200);

        await request(app).post("/api/notifications/push/devices/unrelated_device_identifier/disable")
            .set("Authorization", "Bearer token-owner-a").expect(200);

        const ecdh = createECDH("prime256v1");
        const registration = {
            expectedRevision: 0,
            admissionFence: admission.body.admissionFence,
            enrollmentGeneration: "admitted_generation_0001",
            vapidKeyId: config.vapidKeyId,
            subscription: {
                endpoint: "https://push.example.test/send/admitted",
                keys: {
                    p256dh: ecdh.generateKeys().toString("base64url"),
                    auth: Buffer.alloc(16, 8).toString("base64url"),
                },
            },
        };
        await request(app).put(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-a").send(registration).expect(200);

        const disabled = await request(app).post(`/api/notifications/push/devices/${device}/disable`)
            .set("Authorization", "Bearer token-owner-a").expect(200);
        const contestedAdmission = await request(app).post("/api/notifications/push/admissions").send({
            deviceId: device,
        })
            .set("Authorization", "Bearer token-owner-a").expect(200);

        await request(app).post(`/api/notifications/push/devices/${device}/disable`)
            .set("Authorization", "Bearer token-owner-a").expect(200)
            .expect(response => expect(response.body).to.include({ revision: 3, state: "disabled" }));

        await request(app).put(`/api/notifications/push/devices/${device}`)
            .set("Authorization", "Bearer token-owner-a").send({
                ...registration,
                expectedRevision: disabled.body.revision,
                admissionFence: contestedAdmission.body.admissionFence,
                enrollmentGeneration: "overtaken_generation_01",
                subscription: {
                    ...registration.subscription,
                    endpoint: "https://push.example.test/send/overtaken",
                },
            }).expect(409);
        expect(store.get("owner-a", device)).to.include({ state: "disabled" });
        db.close();
    });
});
