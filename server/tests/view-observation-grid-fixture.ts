import * as Y from "yjs";
import { createGridEntry } from "../../shared/src/services/gridDefinition.js";
import { GRID_OBSERVATION_PARITY } from "../../shared/tests/fixtures/gridObservationParity.js";
import { Project } from "../src/schema/app-schema.js";

/** Seeds the exact live-room inputs shared by the headless and mounted-TableGrid parity oracles. */
export async function seedGridObservationParity(host: any, projectId: string, uid: string): Promise<any[]> {
    const canonical = Project.createInstance("Saved views");
    const choices = table("choices", GRID_OBSERVATION_PARITY.choicesSchema, {
        same: GRID_OBSERVATION_PARITY.choicesRow,
    });
    const notes = table("notes", GRID_OBSERVATION_PARITY.notesSchema, {
        same: GRID_OBSERVATION_PARITY.notesRow,
    });
    for (
        const [id, name, sqlName, doc] of [["choices", "Choices", "choices", choices], ["notes", "Notes", "notes",
            notes]] as const
    ) {
        const entry = new Y.Map<unknown>();
        entry.set("name", name);
        entry.set("sqlName", sqlName);
        entry.set("doc", doc);
        canonical.ydoc.getMap("yjsTables").set(id, entry);
    }
    createGridEntry(canonical.ydoc as never, "heterogeneous", {
        name: "Heterogeneous",
        query: `${GRID_OBSERVATION_PARITY.branchA} UNION ALL ${GRID_OBSERVATION_PARITY.branchB} ORDER BY source_kind`,
        components: { source_kind: { hidden: true }, source_id: { hidden: true }, hidden: { hidden: true } },
    });
    createGridEntry(canonical.ydoc as never, "relation-free", {
        name: "Relation free",
        query: "SELECT DATE '2026-11-21' AS value",
    });
    const project = await host.openDirectConnection(`projects/${projectId}`, { context: { uid } });
    Y.applyUpdate(project.document as Y.Doc, Y.encodeStateAsUpdate(canonical.ydoc as never));
    const sourceConnections = [];
    for (const [id, doc] of [["choices", choices], ["notes", notes]] as const) {
        const connection = await host.openDirectConnection(`projects/${projectId}/tables/${id}`, {
            context: { uid },
        });
        Y.applyUpdate(connection.document as Y.Doc, Y.encodeStateAsUpdate(doc));
        sourceConnections.push(connection);
    }
    return [project, ...sourceConnections];
}

function table(name: string, schema: string, rows: Record<string, Record<string, unknown>>) {
    const doc = new Y.Doc({ guid: `saved-view-${name}` });
    doc.getText("schema").insert(0, schema);
    for (const [id, values] of Object.entries(rows)) {
        const record = new Y.Map<unknown>();
        for (const [key, value] of Object.entries(values)) record.set(key, value);
        record.set("id", id);
        doc.getMap<Y.Map<unknown>>("data").set(id, record);
    }
    return doc;
}
