import { expect } from "chai";
import express from "express";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import request from "supertest";
import type * as Y from "yjs";
import { validateMobilePayload } from "../../../shared/src/notifications/mobile-payload.js";
import type {
    NotificationRule,
    NotificationTargetKind,
} from "../../../shared/src/notifications/notification-settings.js";
import { computeViewRange } from "../../../shared/src/services/calendarGridRange.js";
import type { ViewChangeAttemptOutcome } from "../../src/notifications/prepared-view-change.js";
import type { PushConfig } from "../../src/notifications/push-config.js";
import { createPushDeviceRouter } from "../../src/notifications/push-device-api.js";
import { PushDeviceStore } from "../../src/notifications/push-device-store.js";
import { WebPushDeliveryAdapter } from "../../src/notifications/web-push-delivery.js";
import {
    calendarRule,
    kanbanRule,
    PROJECT,
    rule,
    runtimeFixture,
    type RuntimeOptions,
    UID,
    waitFor,
} from "./observation-runtime.fixture.js";
import { decryptPush, receiverKeys, verifyVapid } from "./web-push-crypto.fixture.js";
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
    captureMcp?: boolean;
} = {}) {
    const f = await runtimeFixture(options.runtimeOptions, {}, options.directory, {
        captureMcp: options.captureMcp,
        captureMobile: false,
    });
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
    const enroll = async (
        deviceId = "browser_device_identifier_a",
        uid = UID,
        enrollmentGeneration = randomBytes(24).toString("base64url"),
    ) => {
        const receiver = receiverKeys();
        const endpoint = `https://push.example.test/send/${deviceId}?opaque=preserved`;
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

/** Bridge the real producer's encrypted output into the production-built browser worker. */
export async function captureProductionMobileDelivery(input: {
    kind: NotificationTargetKind;
    enrollmentGeneration: string;
}) {
    const f = await webPushFixture({ captureMcp: false });
    try {
        const receiver = await f.enroll(`browser_bridge_device_${input.kind}`, UID, input.enrollmentGeneration);
        const { project } = await f.seed();
        const selected = input.kind === "calendar" ? calendarRule() : input.kind === "kanban" ? kanbanRule() : rule();
        const watched = mobileRule(selected);
        const write = (rowId: string, column: string, value: string) => f.call("write_relation", {
            projectId: PROJECT,
            relation: "tasks",
            write: { op: "UPDATE", rowId, column, value },
        });
        if (input.kind === "calendar") {
            const anchorUtcMs = Date.parse("2026-11-21T12:00:00Z");
            const range = computeViewRange(anchorUtcMs, "month", 1, "Asia/Tokyo");
            watched.context = {
                version: 1,
                locale: "ja-JP",
                timeZone: "Asia/Tokyo",
                weekStart: 1,
                viewType: "month",
                anchorUtcMs,
                rangeStartUtcMs: range.start,
                rangeEndUtcMs: range.end,
                monthLaneFilter: "todo",
                collapsedEntryKeys: [],
            };
            const definition = project.getMap<Y.Map<unknown>>("calendars").get("calendar")!;
            definition.set("groupAxes", ["status"]);
            definition.set("query", "SELECT id AS source_id, 'tasks' AS source_kind, title, starts, status FROM tasks "
                + "WHERE starts >= current_setting('view.range_start')::date AND starts < current_setting('view.range_end')::date");
            // Keep the selected lane present when the observed source change removes its first entry.
            await write("b", "status", "todo");
        } else {
            watched.context = {
                version: 1,
                locale: "en-GB",
                timeZone: "Asia/Tokyo",
                surface: input.kind === "grid" ? "table" : "board",
            };
        }
        f.runtime.start();
        await f.update([watched]);
        await f.watching([watched.ruleId]);
        expect(f.captured.requests).to.have.length(0);
        if (input.kind === "calendar") await write("a", "starts", "2026-12-21");
        else if (input.kind === "kanban") await write("a", "status", "done");
        else await write("a", "title", "Displayed bridge update");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.captured.requests).to.have.length(1);
        expect(f.settlements).to.deep.equal([{ initiated: true, outcome: "accepted" }]);
        const captured = f.captured.requests[0];
        const { payload, plaintext } = decryptPush(captured, receiver);
        verifyVapid(captured, f.config);
        const savedRule = f.server.notificationSettings.get(UID).rules.find(saved => saved.ruleId === watched.ruleId);
        if (!savedRule) throw new Error("Expected the committed notification rule");
        const observed = f.reads.findLast(read =>
            read.objectId === watched.target.objectId && read.result.status === "ready"
        )?.result;
        if (!observed || observed.status !== "ready") throw new Error("Expected a complete production observation");
        expect(validateMobilePayload(payload)).to.deep.equal(payload);
        expect(payload.target).to.deep.equal(savedRule.target);
        expect(payload.ruleId).to.equal(savedRule.ruleId);
        expect(payload.enrollmentGeneration).to.equal(input.enrollmentGeneration);
        expect(payload.href).to.equal(observed.deepLink);
        return {
            // Preserve the decrypted bytes as UTF-8; the browser passes this string directly to CDP.
            plaintext: plaintext.toString("utf8"),
            payload,
            rule: savedRule,
            capture: {
                requestCount: f.captured.requests.length,
                encryptedBytes: captured.body.byteLength,
                vapidVerified: true,
                accepted: f.settlements[0].outcome === "accepted",
            },
        };
    } finally {
        await f.close();
    }
}

// Run outside Vitest so the existing server loader preserves one Yjs instance across server/shared sources.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [kind, enrollmentGeneration] = process.argv.slice(2);
    if ((kind !== "grid" && kind !== "calendar" && kind !== "kanban") || !enrollmentGeneration) {
        throw new Error("usage: web-push.fixture.ts (grid|calendar|kanban) ENROLLMENT_GENERATION");
    }
    captureProductionMobileDelivery({ kind, enrollmentGeneration }).then(delivery => {
        // PGlite leaves an idle WASM message channel after its completed cleanup, as in the native Mocha runner.
        process.stdout.write(`\nOUTLINER_MOBILE_DELIVERY:${JSON.stringify(delivery)}\n`, () => process.exit(0));
    }).catch(error => {
        console.error(error);
        process.exit(1);
    });
}
