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
        expect(store.register("owner-a", device, input)).to.include({ revision: 1, state: "registered" });
        expect(store.register("owner-a", device, input)).to.include({ revision: 1, state: "registered" });
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
});
