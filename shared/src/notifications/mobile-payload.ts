import { decodeCalendarObservationContext, encodeCalendarObservationContext } from "./calendarProjection.js";
import { parseGridObservationContext } from "./gridProjection.js";
import { parseKanbanObservationContext } from "./kanbanProjection.js";
import type { NotificationTarget } from "./notification-settings.js";

export const MAX_MOBILE_PAYLOAD_BYTES = 3000;

/** The complete browser-safe wire format. Private owner/device credentials never belong here. */
export interface MobilePayloadV1 {
    readonly schemaVersion: 1;
    readonly eventId: string;
    readonly ruleId: string;
    readonly enrollmentGeneration: string;
    readonly target: Readonly<NotificationTarget>;
    readonly observedAt: string;
    readonly title: string;
    readonly body: string;
    readonly href: string;
}

const PAYLOAD_KEYS = ["schemaVersion", "eventId", "ruleId", "enrollmentGeneration", "target", "observedAt", "title",
    "body", "href"];
const TARGET_KEYS = ["projectId", "kind", "objectId"];
const ID = /^[A-Za-z0-9_-]{1,200}$/u;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ORIGIN = "https://outliner.invalid";

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const present = Object.keys(value);
    return present.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function text(value: unknown, maximum: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROLS.test(value);
}
function target(value: unknown): value is NotificationTarget {
    return record(value) && exactKeys(value, TARGET_KEYS)
        && typeof value.projectId === "string" && ID.test(value.projectId)
        && typeof value.objectId === "string" && ID.test(value.objectId)
        && (value.kind === "grid" || value.kind === "calendar" || value.kind === "kanban");
}

/** Accept only the producer's exact object route and explicit saved display context. */
export function validateMobileHref(href: unknown, identity: Readonly<NotificationTarget>): href is string {
    if (
        !target(identity) || typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")
        || /[\\\s#]/u.test(href) || href.length > MAX_MOBILE_PAYLOAD_BYTES
    ) return false;
    try {
        const url = new URL(href, ORIGIN);
        const plural = identity.kind === "kanban" ? "kanbans" : `${identity.kind}s`;
        const expected = `/${encodeURIComponent(identity.projectId)}/-/${plural}/${
            encodeURIComponent(identity.objectId)
        }`;
        if (url.origin !== ORIGIN || url.pathname !== expected || href !== `${url.pathname}${url.search}`) return false;
        const parameters = url.searchParams;
        const keys: string[] = [];
        parameters.forEach((_value, key) => keys.push(key));
        const required = identity.kind === "grid" ? ["observation"] : identity.kind === "calendar"
            ? ["context"]
            : ["surface", "version", "locale", "timeZone"];
        if (keys.length !== required.length || required.some(key => !parameters.has(key))) return false;
        // The producer uses URLSearchParams once; reject ambiguous or noncanonical encodings.
        if (url.search !== `?${parameters.toString()}`) return false;
        if (identity.kind === "grid") {
            return parseGridObservationContext(parameters.get("observation")!).status === "supported";
        }
        if (identity.kind === "kanban") return parseKanbanObservationContext(parameters).status === "valid";
        const encoded = parameters.get("context")!;
        const parsed = decodeCalendarObservationContext(encoded);
        return parsed.valid && encodeCalendarObservationContext(parsed.context) === encoded;
    } catch {
        return false;
    }
}

/** Validate both transport input and notification data again on activation. No permissive fallback. */
export function validateMobilePayload(value: unknown): MobilePayloadV1 | undefined {
    try {
        if (!record(value) || !exactKeys(value, PAYLOAD_KEYS) || value.schemaVersion !== 1 || !target(value.target)) {
            return undefined;
        }
        if (
            !text(value.eventId, 200) || !text(value.ruleId, 200)
            || typeof value.enrollmentGeneration !== "string"
            || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.enrollmentGeneration)
            || !text(value.observedAt, 30) || new Date(value.observedAt).toISOString() !== value.observedAt
            || !text(value.title, 80) || !text(value.body, 1200) || !validateMobileHref(value.href, value.target)
            || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_MOBILE_PAYLOAD_BYTES
        ) return undefined;
        return value as unknown as MobilePayloadV1;
    } catch {
        return undefined;
    }
}
