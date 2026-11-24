import { expandItemOccurrences } from "$shared/services/calendarItemOccurrences";
import type { Item } from "../../schema/app-schema";
import { runCalendarQuery } from "../../services/calendar/calendarQueryRunner";
import { createRecurrenceOverride } from "../../services/calendar/recurrenceEditing";
import { projectSchemaName } from "../../services/yjstable/sqlNames";
import { createTableEngineSession } from "../../services/yjstable/tableEngine";
import type { TableQueryResult } from "../../services/yjstable/tableSyncAdapter";
import type { mountHours } from "./calendarHoursProjection";

/** Independent real SQL acknowledgement around a post-ready write through the recurrence/outline owners. */
export async function createHoursOverrideAndRead(f: ReturnType<typeof mountHours>) {
    const session = createTableEngineSession({ projectDoc: f.doc, projectId: f.doc.guid });
    let unsubscribe: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let override: Item | undefined;
    const query = () =>
        runCalendarQuery(session, projectSchemaName(f.doc.guid), f.query, {
            start: new Date(f.context.rangeStartUtcMs),
            end: new Date(f.context.rangeEndUtcMs),
        }, f.context.timeZone);
    try {
        const provider = await session.resolveRelation("outline_items");
        if (!provider?.subscribeInvalidation) throw Error("Missing native outline invalidation port");
        const before = await query();
        if (!before.result || before.error) throw Error(before.error ?? "Missing initial SQL acknowledgement");
        const occurrence = expandItemOccurrences(f.recurring, f.context.rangeStartUtcMs, f.context.rangeEndUtcMs)
            .find(value => value.occurrenceId === "2026-03-08T09:00:00");
        if (!occurrence) throw Error("Missing representative 09:00 occurrence");
        const after = await new Promise<TableQueryResult>((resolve, reject) => {
            deadline = setTimeout(() => reject(Error("SQL did not acknowledge the real occurrence override")), 10000);
            unsubscribe = provider.subscribeInvalidation!(() => {
                void query().then(outcome => {
                    if (outcome.error) reject(Error(outcome.error));
                    const row = outcome.result?.rows.find(value => value.source_id === override?.key);
                    if (
                        row?.title === "Moved one occurrence"
                        && Date.parse(String(row.start_value)) === Date.parse("2026-03-08T19:15:00Z")
                    ) {
                        resolve(outcome.result!);
                    }
                }, reject);
            });
            f.doc.transact(() => {
                override = createRecurrenceOverride(f.project.tree, f.recurring, occurrence, {
                    text: "Moved one occurrence",
                    duration: "PT20M",
                });
                // The returned override is now an ordinary authoritative outline Item, as in the app's owner path.
                override.start = "2026-03-08T19:15:00Z";
            });
        });
        return { before: before.result, after, override: override!, occurrence };
    } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        unsubscribe?.();
        session.dispose();
    }
}
