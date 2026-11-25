import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import type { GridVisibleProjection } from "../../shared/src/notifications/gridProjection.js";
import { ViewObservationService } from "../src/notifications/view-observation.js";
import { seedGridObservationParity } from "./view-observation-grid-fixture.js";

/** Runs the shipped retained observer in an isolated server runtime for the mounted-UI parity test. */
export interface GridObservationParityInputs {
    projectUpdate: string;
    gridId: string;
    tables: readonly { id: string; update: string; }[];
}

export async function captureGridObservationParity(
    inputs?: GridObservationParityInputs,
): Promise<GridVisibleProjection> {
    const projectId = "table-grid-headless-parity";
    const uid = "owner";
    const host = new Hocuspocus({ name: "table-grid-headless-parity", quiet: true });
    const connections = inputs
        ? await seedAcceptedInputs(host, projectId, uid, inputs)
        : await seedGridObservationParity(host, projectId, uid);
    try {
        const service = new ViewObservationService(host, async () => true);
        const handle = await service.openViewObservation({
            uid,
            target: { projectId, kind: "grid", objectId: inputs?.gridId ?? "heterogeneous" },
            context: { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" },
        });
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: 1 });
        await handle.close();
        if (snapshot.status !== "ready" || !("kind" in snapshot.projection) || snapshot.projection.kind !== "grid") {
            throw new Error(`Expected ready Grid snapshot: ${JSON.stringify(snapshot)}`);
        }
        return snapshot.projection;
    } finally {
        await Promise.all(connections.map(connection => connection.disconnect()));
        host.closeConnections();
    }
}

async function seedAcceptedInputs(
    host: Hocuspocus,
    projectId: string,
    uid: string,
    inputs: GridObservationParityInputs,
) {
    const project = await host.openDirectConnection(`projects/${projectId}`, { context: { uid } });
    Y.applyUpdate(project.document as Y.Doc, Buffer.from(inputs.projectUpdate, "base64"));
    const sources = await Promise.all(inputs.tables.map(async table => {
        const connection = await host.openDirectConnection(`projects/${projectId}/tables/${table.id}`, {
            context: { uid },
        });
        Y.applyUpdate(connection.document as Y.Doc, Buffer.from(table.update, "base64"));
        return connection;
    }));
    return [project, ...sources];
}
