import Database from "better-sqlite3";
import { expect } from "chai";
import { PushDeviceError, PushDeviceStore } from "../../src/notifications/push-device-store.js";

const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
const auth = Buffer.alloc(16, 2).toString("base64url");
const device = "device_identifier_0001";

describe("private Web Push device store", () => {
    it("commits idempotently, fences stale admission on disable, and survives reopening", () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const admissionFence = store.issueAdmission("owner-a", device);
        const input = {
            endpoint: "https://push.example.test/send/1",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: 0,
            admissionFence,
            enrollmentGeneration: "generation_marker_0001",
        };
        expect(store.register("owner-a", device, input)).to.include({
            revision: 1,
            state: "registered",
            enrollmentGeneration: "generation_marker_0001",
        });
        const renewedInput = {
            ...input,
            expectedRevision: 1,
            admissionFence: store.issueAdmission("owner-a", device),
            enrollmentGeneration: "generation_marker_0002",
        };
        expect(store.register("owner-a", device, renewedInput)).to.include({
            revision: 2,
            state: "registered",
            enrollmentGeneration: "generation_marker_0002",
        });
        expect(store.register("owner-a", device, renewedInput)).to.include({
            revision: 2,
            enrollmentGeneration: "generation_marker_0002",
        });
        expect(store.disable("owner-a", device)).to.include({ revision: 3, state: "disabled" });
        expect(() => store.register("owner-a", device, { ...input, expectedRevision: 3 })).to.throw(PushDeviceError,
            "stale");
        expect(new PushDeviceStore(db).get("owner-a", device)).to.include({ revision: 3, state: "disabled" });
        db.close();
    });

    it("keeps another device's admitted authority when an absent device is disabled", () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const admittedDevice = "admitted_device_identifier";
        const fence = store.issueAdmission("owner-a", admittedDevice);

        expect(store.disable("owner-a", "unrelated_device_identifier")).to.equal(undefined);
        expect(store.register("owner-a", admittedDevice, {
            endpoint: "https://push.example.test/admitted",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: 0,
            admissionFence: fence,
            enrollmentGeneration: "admitted_generation_0001",
        })).to.include({ state: "registered", enrollmentGeneration: "admitted_generation_0001" });
        db.close();
    });

    it("limits stale cleanup to its exact admission or committed generation", () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const staleAdmission = store.issueAdmission("owner-a", device);
        const currentAdmission = store.issueAdmission("owner-a", device);
        store.disable("owner-a", device, { admissionFence: staleAdmission });
        const first = store.register("owner-a", device, {
            endpoint: "https://push.example.test/current/1",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: 0,
            admissionFence: currentAdmission,
            enrollmentGeneration: "current_generation_0001",
        });
        const second = store.register("owner-a", device, {
            endpoint: "https://push.example.test/current/2",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: first.revision,
            admissionFence: store.issueAdmission("owner-a", device),
            enrollmentGeneration: "current_generation_0002",
        });

        expect(store.disable("owner-a", device, {
            expectedRevision: first.revision,
            enrollmentGeneration: "current_generation_0001",
        })).to.deep.equal(second);
        expect(store.get("owner-a", device)).to.include({
            state: "registered",
            enrollmentGeneration: "current_generation_0002",
        });
        db.close();
    });

    it("does not allocate absent disables and rejects cross-owner endpoint transfer", () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        expect(store.disable("owner-a", device)).to.equal(undefined);
        expect(store.list("owner-a")).to.deep.equal([]);
        const input = {
            endpoint: "https://push.example.test/send/shared",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: 0,
            admissionFence: store.issueAdmission("owner-a", device),
            enrollmentGeneration: "generation_marker_0001",
        };
        store.register("owner-a", device, input);
        expect(() =>
            store.register("owner-b", "device_identifier_0002", {
                ...input,
                admissionFence: store.issueAdmission("owner-b", "device_identifier_0002"),
                enrollmentGeneration: "generation_marker_0002",
            })
        ).to.throw(PushDeviceError, "conflicts with an existing destination");
        db.close();
    });

    it("fences admitted first enrollment without a tombstone and enforces capacity on reactivation", () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const pendingFence = store.issueAdmission("pending-owner", device);
        expect(store.disable("pending-owner", device)).to.equal(undefined);
        expect(store.list("pending-owner")).to.deep.equal([]);
        expect(() => store.register("pending-owner", device, {
            endpoint: "https://push.example.test/pending",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: 0,
            admissionFence: pendingFence,
            enrollmentGeneration: "generation_pending_01",
        })).to.throw(PushDeviceError, "stale");

        for (let index = 0; index < 16; index++) {
            store.register("full-owner", `capacity_device_${index.toString().padStart(2, "0")}`, {
                endpoint: `https://push.example.test/capacity/${index}`,
                p256dh: key,
                auth,
                vapidKeyId: "key-1",
                expectedRevision: 0,
                admissionFence: store.issueAdmission("full-owner",
                    `capacity_device_${index.toString().padStart(2, "0")}`),
                enrollmentGeneration: `capacity_generation_${index.toString().padStart(2, "0")}`,
            });
        }
        const disabled = store.disable("full-owner", "capacity_device_00")!;
        store.register("full-owner", "capacity_replacement", {
            endpoint: "https://push.example.test/capacity/replacement",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: 0,
            admissionFence: store.issueAdmission("full-owner", "capacity_replacement"),
            enrollmentGeneration: "capacity_replacement_generation",
        });
        expect(() => store.register("full-owner", "capacity_device_00", {
            endpoint: "https://push.example.test/capacity/reactivated",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: disabled.revision,
            admissionFence: store.issueAdmission("full-owner", "capacity_device_00"),
            enrollmentGeneration: "capacity_reactivation_generation",
        })).to.throw(PushDeviceError, "capacity");
        expect(store.get("full-owner", "capacity_device_00")).to.include({ state: "disabled" });
        db.close();
    });
});
