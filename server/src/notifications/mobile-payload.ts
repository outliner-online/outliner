import {
    MAX_MOBILE_PAYLOAD_BYTES,
    type MobilePayloadV1,
    validateMobilePayload,
} from "../../../shared/src/notifications/mobile-payload.js";
import type { ViewChangePayload } from "./prepared-view-change.js";

const TITLES = { grid: "Grid changed", calendar: "Calendar changed", kanban: "Kanban changed" } as const;
const TRUNCATED = "… [truncated]";

/** Only the producer's displayed-field summary enters the phone payload. */
export function buildMobilePayload(
    candidate: ViewChangePayload,
    enrollmentGeneration: string,
): MobilePayloadV1 | undefined {
    const counts = candidate.summary.counts;
    const headline = `Displayed items changed: ${counts.changedItems}; labels changed: ${counts.changedLabels}.`;
    const examples = candidate.summary.examples.map(example => {
        // These characters cannot be visibly represented in a plain-text notification.
        const text = example.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
        return `${text}${example.truncated ? " [truncated]" : ""}`;
    }).join("\n");
    const omitted = candidate.summary.examplesTruncated ? "\n[more examples omitted]" : "";
    const payload = (body: string): MobilePayloadV1 => ({
        schemaVersion: 1,
        eventId: candidate.eventId,
        ruleId: candidate.ruleId,
        enrollmentGeneration,
        target: { ...candidate.target },
        observedAt: candidate.observedAt,
        title: TITLES[candidate.target.kind],
        body,
        href: candidate.deepLink,
    });
    const full = payload(`${headline}${examples ? `\n${examples}` : ""}${omitted}`);
    if (validateMobilePayload(full)) return full;

    // Keep identities and the exact saved-context URL intact. Only displayed
    // examples can shrink, and every omission remains explicit.
    const characters = [...examples];
    for (let length = characters.length - 1; length >= 0; length--) {
        const shortened = payload(`${headline}\n${characters.slice(0, length).join("")}${TRUNCATED}${omitted}`);
        if (Buffer.byteLength(JSON.stringify(shortened), "utf8") <= MAX_MOBILE_PAYLOAD_BYTES) {
            const valid = validateMobilePayload(shortened);
            if (valid) return valid;
        }
    }
    return undefined;
}
