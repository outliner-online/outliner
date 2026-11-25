import { runCalendarQuery } from "../../services/calendar/calendarQueryRunner";
import { projectSchemaName } from "../../services/yjstable/sqlNames";
import { createTableEngineSession } from "../../services/yjstable/tableEngine";
import type { TableQueryResult } from "../../services/yjstable/tableSyncAdapter";
import type { mountGantt } from "./calendarGanttProjection";

/** Independent native SQL acknowledgement of a single authoritative hidden descendant title edit. */
export async function editHiddenGanttTitleAndRead(f: ReturnType<typeof mountGantt>, title: string) {
    const session = createTableEngineSession({ projectDoc: f.doc, projectId: f.doc.guid });
    let unsubscribe: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
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
        const after = await new Promise<TableQueryResult>((resolve, reject) => {
            deadline = setTimeout(() => reject(Error("SQL did not acknowledge the hidden title edit")), 10000);
            unsubscribe = provider.subscribeInvalidation!(() => {
                void query().then(outcome => {
                    if (outcome.error) reject(Error(outcome.error));
                    if (outcome.result?.rows.some(row => row.source_id === f.grandchild.key && row.title === title)) {
                        resolve(outcome.result);
                    }
                }, reject);
            });
            f.grandchild.text = title;
        });
        return { before: before.result, after };
    } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        unsubscribe?.();
        session.dispose();
    }
}
