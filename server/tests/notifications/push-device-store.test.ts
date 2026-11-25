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
        const admissionFence = store.issueAdmission("owner-a");
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
        expect(store.register("owner-a", device, {
            ...input,
            enrollmentGeneration: "generation_marker_0002",
        })).to.include({
            revision: 1,
            state: "registered",
            enrollmentGeneration: "generation_marker_0001",
        });
        expect(store.disable("owner-a", device)).to.include({ revision: 2, state: "disabled" });
        expect(() => store.register("owner-a", device, { ...input, expectedRevision: 2 })).to.throw(PushDeviceError,
            "stale");
        expect(new PushDeviceStore(db).get("owner-a", device)).to.include({ revision: 2, state: "disabled" });
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
            admissionFence: store.issueAdmission("owner-a"),
            enrollmentGeneration: "generation_marker_0001",
        };
        store.register("owner-a", device, input);
        expect(() =>
            store.register("owner-b", "device_identifier_0002", {
                ...input,
                admissionFence: store.issueAdmission("owner-b"),
                enrollmentGeneration: "generation_marker_0002",
            })
        ).to.throw(PushDeviceError, "conflicts with an existing destination");
        db.close();
    });

    it("fences admitted first enrollment without a tombstone and enforces capacity on reactivation", () => {
        const db = new Database(":memory:");
        const store = new PushDeviceStore(db);
        store.initialize();
        const pendingFence = store.issueAdmission("pending-owner");
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
                admissionFence: store.issueAdmission("full-owner"),
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
            admissionFence: store.issueAdmission("full-owner"),
            enrollmentGeneration: "capacity_replacement_generation",
        });
        expect(() => store.register("full-owner", "capacity_device_00", {
            endpoint: "https://push.example.test/capacity/reactivated",
            p256dh: key,
            auth,
            vapidKeyId: "key-1",
            expectedRevision: disabled.revision,
            admissionFence: store.issueAdmission("full-owner"),
            enrollmentGeneration: "capacity_reactivation_generation",
        })).to.throw(PushDeviceError, "capacity");
        expect(store.get("full-owner", "capacity_device_00")).to.include({ state: "disabled" });
        db.close();
    });
});
