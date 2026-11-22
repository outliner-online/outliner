import { deriveCalendarDaysVisibleModel } from "$shared/notifications/calendarDaysVisibleModel";
import { runCalendarQuery } from "../../services/calendar/calendarQueryRunner";
import { getCalendar } from "../../services/calendar/calendarService";
import { projectSchemaName } from "../../services/yjstable/sqlNames";
import { createTableEngineSession } from "../../services/yjstable/tableEngine";
import type { TableQueryResult } from "../../services/yjstable/tableSyncAdapter";
import { mountDays, timeGridDom } from "./calendarDaysProjection";

export function mountGroupedDays(viewType: "days" | "week") {
    return mountDays(viewType, true, true);
}

/** Observe real relation notifications and SQL acknowledgement; never synthesize a query result. */
export async function editClippedTextAndRead(f: ReturnType<typeof mountGroupedDays>, text: string) {
    const session = createTableEngineSession({ projectDoc: f.doc, projectId: f.doc.guid });
    let unsubscribe: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const provider = await session.resolveRelation("outline_items");
        if (!provider?.subscribeInvalidation) throw Error("Missing native items invalidation port");
        const result = await new Promise<TableQueryResult>((resolve, reject) => {
            deadline = setTimeout(() => reject(Error("Real SQL never acknowledged the clipped source edit")), 10000);
            unsubscribe = provider.subscribeInvalidation!(() => {
                void runCalendarQuery(session, projectSchemaName(f.doc.guid), f.query, {
                    start: new Date(f.context.rangeStartUtcMs),
                    end: new Date(f.context.rangeEndUtcMs),
                }, f.context.timeZone).then(outcome => {
                    if (outcome.error) reject(Error(outcome.error));
                    if (outcome.result?.rows.some(row => row.source_id === f.outside.key && row.title === text)) {
                        resolve(outcome.result);
                    }
                }, reject);
            });
            f.outside.text = text;
        });
        const settings = getCalendar(f.project, f.calendarId);
        if (!settings) throw Error("Missing committed Calendar");
        return {
            result,
            comparable: deriveCalendarDaysVisibleModel({
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

/** Actual lane DOM order, labels and each nested grid's CSS, independent of the producer. */
export function groupedDaysDom(root: HTMLElement) {
    const grid = root.querySelector<HTMLElement>('[data-testid="calendar-lane-time-grid"]')!;
    const bands = Array.from(grid.querySelectorAll<HTMLElement>(".lane-band"));
    const label = (band: HTMLElement) => band.querySelector(".lane-header")!.textContent!.trim();
    const contents = bands.map(band =>
        timeGridDom(band.querySelector<HTMLElement>('[data-testid="calendar-time-grid"]')!)
    );
    return {
        version: 1,
        title: root.querySelector('[data-testid="calendar-name"]')!.textContent,
        rangeLabel: root.querySelector('[data-testid="calendar-range-label"]')!.textContent,
        modeLabel:
            root.querySelector<HTMLSelectElement>('[data-testid="calendar-view-type"]')!.selectedOptions[0].textContent,
        labels: [
            ...Array.from(grid.querySelectorAll(":scope > .day-header-row .day-header-cell"))
                .map(node => node.textContent!.trim()),
            ...bands.flatMap((band, index) => [label(band), ...contents[index].labels]),
        ],
        content: bands.flatMap((band, lane) => [
            { kind: "lane", lane, label: label(band) },
            ...contents[lane].content.map(value => ({ ...value, lane })),
        ]),
    };
}
