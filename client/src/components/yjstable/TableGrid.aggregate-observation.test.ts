import { cleanup, render, waitFor } from "@testing-library/svelte";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { setGridQuery } from "../../services/yjstable/gridDocs";
import { getGridProjection } from "../../services/yjstable/gridProjectionRegistry";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { addRecord, setRecordValue } from "../../services/yjstable/tableDocs";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { setupSavedPresentation } from "./__fixtures__/mcpPresentation";
import ProjectGridView from "./ProjectGridView.svelte";

// Monaco layout is unavailable in jsdom; actual SQL, metadata and rendering remain active.
vi.mock("../../lib/monaco/monacoLoader", () => ({
    loadMonaco: () => import("../../tests/mocks/fakeMonaco").then(module => module.fakeMonaco),
}));
const execFileAsync = promisify(execFile);
let fixture: ReturnType<typeof setupSavedPresentation>;
afterEach(async () => {
    cleanup();
    fixture?.projectDoc.destroy();
    await resetTableEngineForTests();
});
afterAll(async () => await resetPgliteForTests());

async function headless() {
    const inputs = {
        projectUpdate: Buffer.from(Y.encodeStateAsUpdate(fixture.projectDoc)).toString("base64"),
        gridId: fixture.grid.gridId,
        tables: [{
            id: fixture.handles.tableId,
            update: Buffer.from(Y.encodeStateAsUpdate(fixture.handles.doc)).toString("base64"),
        }],
    };
    const { stdout } = await execFileAsync(process.execPath, [
        "--loader",
        "ts-node/esm",
        "--loader",
        "./tests/loaders/pin-server-deps.mjs",
        "--no-warnings",
        "--input-type=module",
        "-e",
        "import('./tests/view-observation-grid-probe.ts').then(async m => { "
        + "console.log('AGGREGATE:' + JSON.stringify(await m.captureGridObservationParity(JSON.parse(process.env.GRID_PARITY_INPUTS)))); process.exit(0) })",
    ], {
        cwd: path.resolve(process.cwd(), "../server"),
        timeout: 60_000,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1", GRID_PARITY_INPUTS: JSON.stringify(inputs) },
    });
    const line = stdout.split("\n").find(line => line.startsWith("AGGREGATE:"));
    expect(line, stdout).toBeDefined();
    return JSON.parse(line!.slice("AGGREGATE:".length));
}

describe("complete aggregate observation uses displayed result types without write lineage", () => {
    it("matches mounted COUNT cells and detects only changed aggregate output", { timeout: 120_000 }, async () => {
        fixture = setupSavedPresentation();
        setGridQuery(fixture.grid, "SELECT COUNT(*) AS total FROM tasks");
        const view = render(ProjectGridView, { props: { grid: fixture.grid, projectDoc: fixture.projectDoc } });
        await waitFor(() => expect(view.container.querySelector("td[data-col='total'] button")).toHaveTextContent("2"),
            { timeout: 30_000 });
        await waitFor(() => expect(getGridProjection(fixture.grid.gridId).status).toBe("ready"));
        const initial = getGridProjection(fixture.grid.gridId);
        if (initial.status !== "ready") throw new Error("Expected a complete aggregate projection");
        expect(initial.projection.rows).toEqual([[{ value: "2" }]]);
        expect(await headless()).toEqual(initial.projection);
        // Aggregate rows do not gain physical edit authority from this change.
        expect(view.container.querySelector("td[data-col='total'] button")).toHaveAttribute("aria-disabled", "true");

        setRecordValue(fixture.handles, "r1", "title", "Changed input, equal count");
        await waitFor(() => expect(getGridProjection(fixture.grid.gridId)).toEqual(initial));
        expect(await headless()).toEqual(initial.projection);

        addRecord(fixture.handles, { title: "Third", due_date: "2026-12-01", done: false }, "r3");
        await waitFor(() => expect(view.container.querySelector("td[data-col='total'] button")).toHaveTextContent("3"));
        await waitFor(() => {
            const next = getGridProjection(fixture.grid.gridId);
            expect(next.status).toBe("ready");
            if (next.status === "ready") expect(next.projection.rows).toEqual([[{ value: "3" }]]);
        });
        const next = getGridProjection(fixture.grid.gridId);
        if (next.status !== "ready") throw new Error("Expected the changed complete aggregate projection");
        expect(await headless()).toEqual(next.projection);
    });
});
