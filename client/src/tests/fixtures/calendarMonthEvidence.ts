import { deriveCalendarMonthVisibleModel } from "$shared/notifications/calendarMonthVisibleModel";
import { runCalendarQuery } from "../../services/calendar/calendarQueryRunner";
import { getCalendar } from "../../services/calendar/calendarService";
import { projectSchemaName } from "../../services/yjstable/sqlNames";
import { createTableEngineSession } from "../../services/yjstable/tableEngine";
import type { TableQueryResult } from "../../services/yjstable/tableSyncAdapter";
import type { mountMonth } from "./calendarMonthProjection";

/** Fresh SQL acknowledgement of a hidden real source edit, independent of view publications. */
export async function editHiddenMonthText(f: ReturnType<typeof mountMonth>) {
    const session = createTableEngineSession({ projectDoc: f.doc, projectId: f.doc.guid });
    let unsubscribe: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const text = "Changed hidden payload";
    try {
        const provider = await session.resolveRelation("outline_items");
        if (!provider?.subscribeInvalidation) throw Error("Missing real items invalidation port");
        const result = await new Promise<TableQueryResult>((resolve, reject) => {
            deadline = setTimeout(() => reject(Error("SQL never acknowledged hidden edit")), 10000);
            unsubscribe = provider.subscribeInvalidation!(() => {
                void runCalendarQuery(session, projectSchemaName(f.doc.guid), f.query, {
                    start: new Date(f.context.rangeStartUtcMs),
                    end: new Date(f.context.rangeEndUtcMs),
                }, f.context.timeZone).then(outcome => {
                    if (outcome.error) reject(Error(outcome.error));
                    if (outcome.result?.rows.some(row => row.source_id === f.hidden.key && row.title === text)) {
                        resolve(outcome.result);
                    }
                }, reject);
            });
            f.hidden.text = text;
        });
        const settings = getCalendar(f.project, f.calendarId);
        if (!settings) throw Error("Missing committed Calendar");
        return {
            result,
            comparable: deriveCalendarMonthVisibleModel({
                current: true,
                result,
                settings,
                project: f.project,
                context: f.context,
            }),
        };
    } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        unsubscribe?.();
        session.dispose();
    }
}
