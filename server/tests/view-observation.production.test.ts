import { expect } from "chai";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as Y from "yjs";
import {
    type CalendarObservationContextV1,
    decodeCalendarObservationContext,
} from "../../shared/src/notifications/calendarProjection.js";
import type { GridObservationContextV1 } from "../../shared/src/notifications/gridProjection.js";
import { computeViewRange } from "../../shared/src/services/calendarGridRange.js";
import { createGridEntry, getGridDefinitionTarget, setGridQuery } from "../../shared/src/services/gridDefinition.js";
import { GRID_OBSERVATION_PARITY } from "../../shared/tests/fixtures/gridObservationParity.js";
import { releaseWithoutStore } from "../src/mcp/live-room.js";
import { OutlinerRelationService } from "../src/mcp/relation-service.js";
import { ViewObservationService } from "../src/notifications/view-observation.js";
import { seedGridObservationParity } from "./view-observation-grid-fixture.js";

const UID = "owner";
const PROJECT = "saved-view-production";
const gridContext: GridObservationContextV1 = { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" };
const execFileAsync = promisify(execFile);

describe("Grid observation production UI parity", function() {
    this.timeout(120_000);

    it("compares the headless capture directly with mounted TableGrid semantics", async () => {
        const clientDirectory = path.resolve(process.cwd(), "../client");
        const evidencePath = path.join(os.tmpdir(), `grid-parity-${crypto.randomUUID()}.json`);
        try {
            await execFileAsync(process.execPath, [
                path.join(clientDirectory, "node_modules/vitest/vitest.mjs"),
                "run",
                "--project",
                "unit",
                "--coverage=false",
                "src/components/yjstable/TableGrid.mcp-presentation.test.ts",
                "-t",
                "matches the live projection and headless capture",
            ], {
                cwd: clientDirectory,
                timeout: 100_000,
                env: { ...process.env, NODE_OPTIONS: "", GRID_PARITY_EVIDENCE_PATH: evidencePath },
            });
            const compared = JSON.parse(await readFile(evidencePath, "utf8"));
            expect(compared.heterogeneous.rendered).to.deep.equal(compared.heterogeneous.headless);
            expect(compared.heterogeneous.rendered.rows).to.deep.equal(
                GRID_OBSERVATION_PARITY.expectedVisibleValues.map(value => [{ value }]),
            );
            expect(compared.ambiguous.rendered).to.deep.equal(compared.ambiguous.headless);
            expect(compared.ambiguous.rendered.rows).to.deep.equal(
                GRID_OBSERVATION_PARITY.expectedAmbiguousValues.map(value => [{ value }]),
            );
        } finally {
            await rm(evidencePath, { force: true });
        }
    });
});

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
            rows: GRID_OBSERVATION_PARITY.expectedVisibleValues.map(value => [{ value }]),
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
        expect(snapshot.projection.rows).to.deep.equal(
            GRID_OBSERVATION_PARITY.expectedAmbiguousValues.map(value => [{ value }]),
        );
        await handle.close();
    });

    it("uses the result-OID fallback for a relation-free saved Grid", async () => {
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "relation-free" },
            context: gridContext,
        });
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(snapshot.status).to.equal("ready");
        if (snapshot.status !== "ready" || snapshot.projection.kind !== "grid") throw new Error("Grid not ready");
        expect(snapshot.projection).to.deep.equal({
            kind: "grid",
            title: "Relation free",
            columns: [{ label: "value" }],
            rows: [[{ value: "2026-11-21" }]],
        });
        await handle.close();
    });

    it("does not fabricate source authority from an unrouted source_kind label", async () => {
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "unrouted-label" },
            context: gridContext,
        });
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(snapshot.status).to.equal("ready");
        if (snapshot.status !== "ready" || snapshot.projection.kind !== "grid") throw new Error("Grid not ready");
        expect(snapshot.projection).to.deep.equal({
            kind: "grid",
            title: "Unrouted label",
            columns: [{ label: "value" }],
            rows: [[{ value: "2026-11-21" }]],
        });
        await handle.close();
    });

    it("invalidates and refreshes through the supported MCP Table writer", async () => {
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" },
            context: gridContext,
        });
        const first = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(first.status).to.equal("ready");
        if (first.status !== "ready") throw new Error("Grid not ready");
        let invalidations = 0;
        handle.onInvalidate(() => invalidations++);

        const writer = new OutlinerRelationService(server.hocuspocus, async () => true);
        const written = await writer.writeRelation(UID, PROJECT, "choices", {
            op: "UPDATE",
            rowId: "same",
            column: "observed_on",
            value: "2026-11-26",
        });
        expect(written).to.include({ applied: true, replayed: false, rowId: "same" });
        expect(invalidations).to.equal(1);
        expect(handle.isCurrent(first.versionToken)).to.equal(false);

        const refreshed = await handle.readSnapshot({ observedAtUtcMs: 2 });
        expect(refreshed.status).to.equal("ready");
        if (refreshed.status !== "ready" || refreshed.projection.kind !== "grid") throw new Error("Grid not ready");
        expect(refreshed.projection.rows).to.deep.equal([
            [{ value: "2026-11-26" }],
            [{ value: "2026-11-22T12:34:56.000Z" }],
        ]);
        await handle.close();
    });

    it("refuses a complete PGlite result above the observation row limit", async () => {
        const service = new ViewObservationService(server.hocuspocus, async () => true);
        const handle = await service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "too-many-rows" },
            context: gridContext,
        });
        expect(await handle.readSnapshot({ observedAtUtcMs: 1 })).to.deep.equal({
            status: "unavailable",
            reason: "resource_limit",
        });
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

    it("refuses a held Grid capture when a live source-room incarnation is replaced", async () => {
        const reached = deferred();
        const resume = deferred();
        let openings = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, {
            beforeSourceOpen: async () => {
                if (++openings === 3) {
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
        const room = `projects/${PROJECT}/tables/choices`;
        releaseWithoutStore(held[1] as any);
        server.hocuspocus.documents.delete(room);
        const replacement = await server.hocuspocus.openDirectConnection(room, { context: { uid: UID } });
        held[1] = replacement;
        resume.resolve();
        expect(await pending).to.deep.equal({ status: "stale", reason: "incarnation_lost" });
        expect(await handle.readSnapshot({ observedAtUtcMs: 3 })).to.deep.equal({
            status: "stale",
            reason: "incarnation_lost",
        });
        await handle.close();
    });

    it("never certifies an old Grid query when the definition changes during source opening", async () => {
        const reached = deferred();
        const resume = deferred();
        let sourceOpenings = 0;
        const service = new ViewObservationService(server.hocuspocus, async () => true, {}, {
            beforeSourceOpen: async () => {
                if (++sourceOpenings === 1) {
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const opening = service.openViewObservation({
            uid: UID,
            target: { projectId: PROJECT, kind: "grid", objectId: "heterogeneous" },
            context: gridContext,
        });
        await reached.promise;
        const projectDoc = (held[0] as any).document as Y.Doc;
        setGridQuery(
            getGridDefinitionTarget(projectDoc as never, "heterogeneous")!,
            "SELECT observed_on AS value FROM choices",
        );
        resume.resolve();
        const handle = await opening;
        const snapshot = await handle.readSnapshot({ observedAtUtcMs: 1 });
        expect(snapshot.status).to.equal("ready");
        if (snapshot.status !== "ready" || snapshot.projection.kind !== "grid") throw new Error("Grid not ready");
        expect(snapshot.projection.rows).to.deep.equal([[{ value: "2026-11-21" }]]);
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
        const link = new URL(snapshot.deepLink, "https://outliner.example");
        expect(decodeCalendarObservationContext(link.searchParams.get("context") ?? "")).to.deep.equal({
            valid: true,
            context,
        });
        await handle.close();
    });
});

async function seedSavedViews(host: any): Promise<any[]> {
    const connections = await seedGridObservationParity(host, PROJECT, UID);
    const project = connections[0];
    const projectDoc = project.document as Y.Doc;
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
    projectDoc.getMap("calendars").set("calendar", calendar);
    return connections;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => resolve = done);
    return { promise, resolve };
}
