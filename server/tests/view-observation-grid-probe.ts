import { Hocuspocus } from "@hocuspocus/server";
import type { GridVisibleProjection } from "../../shared/src/notifications/gridProjection.js";
import { ViewObservationService } from "../src/notifications/view-observation.js";
import { seedGridObservationParity } from "./view-observation-grid-fixture.js";

/** Runs the shipped retained observer in an isolated server runtime for the mounted-UI parity test. */
export async function captureGridObservationParity(): Promise<GridVisibleProjection> {
    const projectId = "table-grid-headless-parity";
    const uid = "owner";
    const host = new Hocuspocus({ name: "table-grid-headless-parity", quiet: true });
    const connections = await seedGridObservationParity(host, projectId, uid);
    try {
        const service = new ViewObservationService(host, async () => true);
        const handle = await service.openViewObservation({
            uid,
            target: { projectId, kind: "grid", objectId: "heterogeneous" },
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
