import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { initiateForEnrollment, updateEnrollmentBinding } from "./enrollmentBinding";
import { armNotificationBinding, barrier, resetNotificationBinding } from "./notification.fixture";

describe("durable enrollment effect boundary", () => {
    beforeEach(resetNotificationBinding);

    it("rejects absent, disarmed and different generations and allows the current one", async () => {
        let initiations = 0;
        const start = async () => ++initiations;
        expect(await initiateForEnrollment("current_enrollment_generation", start)).toEqual({ initiated: false });
        await armNotificationBinding();
        expect(await initiateForEnrollment("old_enrollment_generation", start)).toEqual({ initiated: false });
        expect(await initiateForEnrollment("current_enrollment_generation", start)).toEqual({
            initiated: true,
            value: 1,
        });
        await updateEnrollmentBinding("disarm");
        expect(await initiateForEnrollment("current_enrollment_generation", start)).toEqual({ initiated: false });
        expect(initiations).toBe(1);
    });

    it("permits disarm after initiation without falsely recalling an in-flight display", async () => {
        await armNotificationBinding();
        const started = barrier();
        const completion = barrier();
        const pending = initiateForEnrollment("current_enrollment_generation", () => {
            started.release();
            return completion.promise;
        });
        await started.promise;
        expect(await updateEnrollmentBinding("disarm")).toEqual({ fence: 1 });
        completion.release();
        expect(await pending).toEqual({ initiated: true, value: undefined });
    });

    it("does not treat a failed disarm write as suppression of a still-readable active binding", async () => {
        await armNotificationBinding();
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function() {
            throw new DOMException("Controlled write failure", "QuotaExceededError");
        };
        try {
            await expect(updateEnrollmentBinding("disarm")).rejects.toThrow();
        } finally {
            IDBObjectStore.prototype.put = originalPut;
        }
        const result = await initiateForEnrollment("current_enrollment_generation", async () => "display started");
        expect(result).toEqual({ initiated: true, value: "display started" });
    });

    it("refuses late arm after durable disarm, retaining the replacement generation", async () => {
        const previous = await updateEnrollmentBinding("read");
        await updateEnrollmentBinding("disarm");
        await armNotificationBinding("replacement_generation");
        await expect(updateEnrollmentBinding("arm", {
            fence: previous.fence,
            generation: "current_enrollment_generation",
            vapidKeyId: "key-one",
        })).rejects.toThrow();
        expect((await updateEnrollmentBinding("read")).generation).toBe("replacement_generation");
    });
});
