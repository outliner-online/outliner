import { expect } from "chai";
import * as Y from "yjs";
import type { CalendarObservationContextV1 } from "../../shared/src/notifications/calendarProjection.js";
import type { GridObservationContextV1 } from "../../shared/src/notifications/gridProjection.js";
import { computeViewRange } from "../../shared/src/services/calendarGridRange.js";
import { createGridEntry, getGridDefinitionTarget, setGridQuery } from "../../shared/src/services/gridDefinition.js";
import { ViewObservationService } from "../src/notifications/view-observation.js";
import { Project } from "../src/schema/app-schema.js";

const UID = "owner";
const PROJECT = "saved-view-production";
const gridContext: GridObservationContextV1 = { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" };

describe("default saved Grid and Calendar observation producers", function() {
    this.timeout(30_000);
    let server: any;
    let held: { disconnect(): Promise<void>; }[];
    let stop: (server: unknown) => Promise<void>;

    beforeEach(async () => {
        const fixture = await import("./server-create-table-fixture.js");
        const acl = new fixture.AclStore();
        acl.grant("projectUsers", PROJECT, UID);
        server = await fixture.startTestServer(fixture.tempDir(), acl);
        stop = fixture.stopTestServer;
        held = await seedSavedViews(server.hocuspocus);
    });
    afterEach(async () => {
        await Promise.all(held.map(connection => connection.disconnect()));
        await stop(server);
    });

    it("executes a heterogeneous UNION and preserves occurrence-specific Grid display semantics", async () => {
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" },
            context: gridContext,
        });
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: Date.parse("2026-11-25T00:00:00Z") });
        expect(snapshot.status).to.equal("ready");
        if (snapshot.status !== "ready" || snapshot.projection.kind !== "grid") throw new Error("Grid not ready");
        // These are the actual TableGrid semantics asserted by
        // TableGrid.mcp-presentation.test.ts for the same accepted inputs:
        // DATE uses its physical field, while the computed TIMESTAMP branch
        // uses the result-OID fallback. Source identities remain hidden.
        expect(snapshot.projection).to.deep.equal({
            kind: "grid",
            title: "Heterogeneous",
            columns: [{ label: "value" }],
            rows: [[{ value: "2026-11-21" }], [{ value: "2026-11-22T12:34:56.000Z" }]],
        });
        expect(handle.isCurrent(snapshot.versionToken)).to.equal(true);
        await handle.close();
    });

    it("uses the native result-OID fallback for a legitimately ambiguous Grid mapping", async () => {
        const project = held[0] as any;
        const projectDoc = project.document as Y.Doc;
        setGridQuery(
            getGridDefinitionTarget(projectDoc as never, "heterogeneous")!,
            "SELECT observed_on AS value FROM choices UNION ALL "
                + "SELECT observed_at AS value FROM notes ORDER BY value",
        );
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" },
            context: gridContext,
        });
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(snapshot.status).to.equal("ready");
        if (snapshot.status !== "ready" || snapshot.projection.kind !== "grid") throw new Error("Grid not ready");
        expect(snapshot.projection.rows).to.deep.equal([
            [{ value: "2026-11-21T00:00:00.000Z" }],
            [{ value: "2026-11-22T12:34:56.000Z" }],
        ]);
        await handle.close();
    });

    it("refuses a held Grid capture when its saved definition incarnation is replaced", async () => {
        const reached = deferred();
        const resume = deferred();
        let certifications = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, {
            beforeFinalCertification: async () => {
                if (++certifications === 2) {
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" },
            context: gridContext,
        });
        const source = (held[1] as any).document as Y.Doc;
        source.getMap<Y.Map<unknown>>("data").get("same")!.set("observed_on", "2026-11-25");
        const pending = handle.readSnapshot({ observedAtUtcMs: 2 });
        await reached.promise;
        const projectDoc = (held[0] as any).document as Y.Doc;
        projectDoc.getMap("yjsGrids").delete("heterogeneous");
        createGridEntry(projectDoc as never, "heterogeneous", {
            name: "Replacement",
            query: "SELECT observed_on AS value FROM choices",
        });
        resume.resolve();
        expect(await pending).to.deep.equal({ status: "stale", reason: "incarnation_lost" });
        expect(await handle.readSnapshot({ observedAtUtcMs: 3 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
        await handle.close();
    });

    it("executes Calendar SQL with the explicit saved range and time-zone context", async () => {
        const anchorUtcMs = Date.parse("2026-11-21T12:00:00Z");
        const range = computeViewRange(anchorUtcMs, "day", 1, "UTC");
        const context: CalendarObservationContextV1 = {
            version: 1,
            locale: "en-US",
            timeZone: "UTC",
            weekStart: 1,
            viewType: "day",
            anchorUtcMs,
            rangeStartUtcMs: range.start,
            rangeEndUtcMs: range.end,
            monthLaneFilter: null,
            collapsedEntryKeys: [],
        };
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "calendar", objectId: "calendar" },
            context,
        });
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: anchorUtcMs });
        expect(snapshot.status).to.equal("ready");
        if (snapshot.status !== "ready" || !("version" in snapshot.projection)) throw new Error("Calendar not ready");
        expect(snapshot.projection.title).to.equal("Calendar");
        expect(snapshot.projection.content.some(value => value.kind === "timed" && value.title === "Choice"))
            .to.equal(true);
        expect(snapshot.effectiveContext).to.deep.equal(context);
        await handle.close();
    });
});

async function seedSavedViews(host: any): Promise<any[]> {
    const canonical = Project.createInstance("Saved views");
    const choices = table("choices", "CREATE TABLE choices (id TEXT PRIMARY KEY, observed_on DATE NOT NULL)", {
        same: { observed_on: "2026-11-21" },
    });
    const notes = table("notes", "CREATE TABLE notes (id TEXT PRIMARY KEY, observed_at TIMESTAMP NOT NULL)", {
        same: { observed_at: "2026-11-22 12:34:56" },
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
        query: "SELECT 'choices' AS source_kind, id AS source_id, observed_on AS value FROM choices "
            + "UNION ALL SELECT 'notes' AS source_kind, id AS source_id, "
            + "observed_at + INTERVAL '0 seconds' AS value FROM notes ORDER BY source_kind",
        components: { source_kind: { hidden: true }, source_id: { hidden: true } },
    });
    const calendar = new Y.Map<unknown>();
    calendar.set("name", "Calendar");
    calendar.set("query", "SELECT id AS source_id, 'choices' AS source_kind, "
        + "'Choice' AS title, observed_on AS starts FROM choices "
        + "WHERE observed_on >= current_setting('view.range_start')::date "
        + "AND observed_on < current_setting('view.range_end')::date");
    calendar.set("roleTitle", "title");
    calendar.set("roleStart", "starts");
    calendar.set("groupAxes", []);
    calendar.set("laneOrder", []);
    canonical.ydoc.getMap("calendars").set("calendar", calendar);
    const project = await host.openDirectConnection(`projects/${PROJECT}`, { context: { uid: UID } });
    Y.applyUpdate(project.document as Y.Doc, Y.encodeStateAsUpdate(canonical.ydoc as never));
    const sourceConnections = [];
    for (const [id, doc] of [["choices", choices], ["notes", notes]] as const) {
        const connection = await host.openDirectConnection(`projects/${PROJECT}/tables/${id}`, {
            context: { uid: UID },
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

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => resolve = done);
    return { promise, resolve };
}
