import express from "express";
import { ECDH } from "node:crypto";
import { verifyIdTokenCached } from "../websocket-auth.js";
import { validateHttpsDestination } from "./https-destination.js";
import { loadPushConfig, type PushConfig } from "./push-config.js";
import { PushDeviceError, PushDeviceStore, type ValidatedRegistration } from "./push-device-store.js";

const ID = /^[A-Za-z0-9_-]{16,128}$/u;
function bytes(value: unknown): Buffer | undefined {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
    try {
        return Buffer.from(value, "base64url");
    } catch {
        return undefined;
    }
}
function validP256(value: unknown): value is string {
    const decoded = bytes(value);
    if (!decoded || decoded.length !== 65 || decoded[0] !== 4) return false;
    try {
        ECDH.convertKey(decoded, "prime256v1", undefined, undefined, "uncompressed");
        return true;
    } catch {
        return false;
    }
}
function validate(body: unknown, config: PushConfig): ValidatedRegistration | undefined {
    const value = body as Record<string, unknown> | undefined;
    const subscription = value?.subscription as Record<string, unknown> | undefined;
    const keys = subscription?.keys as Record<string, unknown> | undefined;
    const auth = bytes(keys?.auth);
    if (
        typeof subscription?.endpoint !== "string" || !validateHttpsDestination(subscription.endpoint)
        || !validP256(keys?.p256dh) || auth?.length !== 16
        || value?.vapidKeyId !== config.vapidKeyId || !Number.isSafeInteger(value?.expectedRevision)
        || (value!.expectedRevision as number) < 0 || !Number.isSafeInteger(value?.admissionFence)
        || typeof value?.enrollmentGeneration !== "string" || !ID.test(value.enrollmentGeneration)
    ) return undefined;
    return {
        endpoint: subscription!.endpoint as string,
        p256dh: keys!.p256dh as string,
        auth: keys!.auth as string,
        vapidKeyId: config.vapidKeyId,
        expectedRevision: value!.expectedRevision as number,
        admissionFence: value!.admissionFence as number,
        enrollmentGeneration: value!.enrollmentGeneration as string,
    };
}

export function createPushDeviceRouter(options: {
    store?: PushDeviceStore;
    config?: PushConfig;
    verifyToken?: typeof verifyIdTokenCached;
} = {}) {
    const router = express.Router();
    const verify = options.verifyToken ?? verifyIdTokenCached;
    const config = options.config ?? loadPushConfig();
    router.use("/notifications/push", async (req, res, next) => {
        const token = req.headers.authorization?.match(/^Bearer (.+)$/u)?.[1];
        if (!token) return void res.status(401).json({ error: "Unauthorized" });
        try {
            res.locals.pushUid = (await verify(token)).uid;
            next();
        } catch {
            res.status(401).json({ error: "Unauthorized" });
        }
    });
    router.get("/notifications/push/config", (_req, res) => {
        if (!config) return void res.status(503).json({ available: false, reason: "configuration_unavailable" });
        res.json({ available: true, publicKey: config.publicKey, vapidKeyId: config.vapidKeyId });
    });
    const withStore = (res: express.Response): PushDeviceStore | undefined => {
        if (!options.store) res.status(503).json({ error: "persistence_unavailable" });
        return options.store;
    };
    router.get("/notifications/push/devices", (_req, res) => {
        try {
            const store = withStore(res);
            if (store) res.json({ devices: store.list(res.locals.pushUid) });
        } catch (error) {
            respond(error, res);
        }
    });
    router.get("/notifications/push/devices/:deviceId", (req, res) => {
        if (!ID.test(req.params.deviceId)) return void res.status(400).json({ error: "invalid_device" });
        try {
            const store = withStore(res);
            if (store) {
                res.json(
                    store.get(res.locals.pushUid, req.params.deviceId)
                        ?? { deviceId: req.params.deviceId, revision: 0, state: "disabled" },
                );
            }
        } catch (error) {
            respond(error, res);
        }
    });
    router.post("/notifications/push/admissions", (_req, res) => {
        try {
            const store = withStore(res);
            if (store) res.json({ admissionFence: store.issueAdmission(res.locals.pushUid) });
        } catch (error) {
            respond(error, res);
        }
    });
    router.put("/notifications/push/devices/:deviceId", (req, res) => {
        if (!config) return void res.status(503).json({ error: "configuration_unavailable" });
        if (!ID.test(req.params.deviceId)) return void res.status(400).json({ error: "invalid_device" });
        const input = validate(req.body, config);
        if (!input) return void res.status(400).json({ error: "invalid_registration" });
        try {
            const store = withStore(res);
            if (store) res.json(store.register(res.locals.pushUid, req.params.deviceId, input));
        } catch (error) {
            respond(error, res);
        }
    });
    router.post("/notifications/push/devices/:deviceId/disable", (req, res) => {
        if (!ID.test(req.params.deviceId)) return void res.status(400).json({ error: "invalid_device" });
        try {
            const store = withStore(res);
            if (store) {
                res.json(
                    store.disable(res.locals.pushUid, req.params.deviceId)
                        ?? { deviceId: req.params.deviceId, revision: 0, state: "disabled" },
                );
            }
        } catch (error) {
            respond(error, res);
        }
    });
    return router;
}
function respond(error: unknown, res: express.Response): void {
    if (error instanceof PushDeviceError) {
        res.status(error.code === "unavailable" ? 503 : 409).json({ error: error.code });
    } else res.status(500).json({ error: "request_failed" });
}
