import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { validateHttpsDestination } from "./https-destination.js";
import type { PreparedViewChange } from "./prepared-view-change.js";

const meta = z.record(z.string().max(200), z.json()).refine(value =>
    Object.keys(value).length <= 16 && Buffer.byteLength(JSON.stringify(value)) <= 2048
);
export const listEventsParams = z.strictObject({ _meta: meta.optional(), cursor: z.null().optional() });
const delivery = z.strictObject({
    mode: z.literal("webhook"),
    url: z.string().max(2048).refine(value => !!validateHttpsDestination(value)),
});
const tuple = {
    name: z.literal("outliner.changed"),
    arguments: z.strictObject({}),
    _meta: meta.optional(),
};
export const subscribeEventsParams = z.strictObject({
    ...tuple,
    cursor: z.null().optional(),
    delivery: delivery.extend({ secret: z.string().max(256).regex(/^whsec_[A-Za-z0-9+/=_-]{16,}$/u) }),
    ttlMs: z.number().int().positive().safe().optional(),
});
export const unsubscribeEventsParams = z.strictObject({ ...tuple, delivery });
export const changedEvent = Object.freeze({
    name: "outliner.changed",
    description: "Selected current view changes across the authenticated Outliner account. Best effort; no replay.",
    delivery: ["webhook"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    payloadSchema: {
        type: "object",
        properties: {
            projectId: { type: "string" },
            kind: { enum: ["grid", "kanban", "calendar"] },
            objectId: { type: "string" },
            ruleId: { type: "string" },
            observedAt: { type: "string", format: "date-time" },
            counts: {
                type: "object",
                additionalProperties: false,
                properties: Object.fromEntries(["previousItems", "currentItems", "changedItems", "changedLabels"]
                    .map(key => [key, { type: "integer", minimum: 0 }])),
                required: ["previousItems", "currentItems", "changedItems", "changedLabels"],
            },
            samples: {
                type: "array",
                maxItems: 3,
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        oldDisplay: { type: "string", maxLength: 120 },
                        newDisplay: { type: "string", maxLength: 120 },
                        oldTruncated: { type: "boolean" },
                        newTruncated: { type: "boolean" },
                    },
                    required: ["oldDisplay", "newDisplay", "oldTruncated", "newTruncated"],
                },
            },
            samplesTruncated: { type: "boolean" },
            valuesTruncated: { type: "boolean" },
            deepLink: { type: "string" },
        },
        required: ["projectId", "kind", "objectId", "ruleId", "observedAt", "counts", "samples", "samplesTruncated",
            "valuesTruncated", "deepLink"],
        additionalProperties: false,
    },
});
export function callbackIdentity(clientId: string, url: string): string {
    return createHash("sha256").update(JSON.stringify([clientId, "outliner.changed", {}, url])).digest("hex");
}

/** Explicit allowlist: internal contexts, tokens, raw source data and owner uid never enter the body. */
export function buildChangedEvent(prepared: PreparedViewChange, now: number): unknown {
    const samples = prepared.summary.samples.map(sample => ({ ...sample }));
    const data = {
        projectId: prepared.target.projectId,
        kind: prepared.target.kind,
        objectId: prepared.target.objectId,
        ruleId: prepared.ruleId,
        observedAt: prepared.observedAt,
        counts: { ...prepared.summary.counts },
        samples,
        samplesTruncated: prepared.summary.examplesTruncated,
        valuesTruncated: samples.some(sample => sample.oldTruncated || sample.newTruncated),
        deepLink: prepared.deepLink,
    };
    const event = {
        eventId: prepared.eventId,
        name: "outliner.changed",
        timestamp: new Date(now).toISOString(),
        cursor: null,
        data,
    };
    while (Buffer.byteLength(JSON.stringify(event)) > 16 * 1024 && samples.length) {
        samples.pop();
        data.samplesTruncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(event)) > 16 * 1024) {
        throw new Error("notification envelope exceeds body bound");
    }
    return event;
}
