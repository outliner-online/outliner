import { mountGantt } from "./calendarGanttProjection";

export function groupedGanttFixture() {
    const f = mountGantt(true);
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    let displayOrder = 0;
    const branch = (id: string, group: string | null, sourceId = id) =>
        `SELECT ${displayOrder++} AS display_order, id, parent_id, text AS title, all_day, `
        + "CASE WHEN all_day THEN start_on::text ELSE start_at::text END AS start_value, duration, due, rrule, "
        + `${group === null ? "NULL::text" : literal(group)} AS team, 'outline_items' AS source_kind, `
        + `${literal(sourceId)} AS source_id FROM outline_items WHERE id = ${literal(id)}`;
    // NULL arrives first; B's late row arrives before its early row. A and B
    // intentionally share the same origin key at different concrete positions.
    const branches = [
        branch(f.grandchild.key, null),
        branch(f.outside.key, "B"),
        branch(f.grandchild.key, "A", f.parent.key),
        branch(f.parent.key, "B"),
        branch(f.nested.key, '["Red","Blue"]'),
        branch(f.parent.key, ""),
    ].join(" UNION ALL ");
    const groupQuery = branches + " ORDER BY display_order";
    const reverseGroupQuery = branches + " ORDER BY display_order DESC";
    const activate = () => f.doc.transact(() => {
        f.map.set("groupAxes", ["team", "ignored_deeper_axis"]);
        f.map.set("query", groupQuery);
        f.map.set("laneOrder", ["Unused", "A", "B"]);
        f.map.set("showEmptyLanes", true);
    });
    return { ...f, groupQuery, reverseGroupQuery, activate };
}
