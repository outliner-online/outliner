// Saved presentation stays separate from SELECT eligibility and physical write authorization.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { GRID_OBSERVATION_PARITY } from "../../../../shared/tests/fixtures/gridObservationParity";
import {
    createGrid,
    getGridHandles,
    readGridComponents,
    setGridComponentField,
    setGridQuery,
} from "../../services/yjstable/gridDocs";
import { getGridProjection } from "../../services/yjstable/gridProjectionRegistry";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import {
    addRecord,
    createTable,
    deleteRecord,
    getTableHandles,
    setRecordValue,
    setSchemaText,
} from "../../services/yjstable/tableDocs";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { fakeMonacoRegistry } from "../../tests/mocks/fakeMonaco";
import { QUERY, setupSavedPresentation } from "./__fixtures__/mcpPresentation";
import ProjectGridView from "./ProjectGridView.svelte";

const execFileAsync = promisify(execFile);

// Monaco's browser editor requires layout APIs absent from jsdom; SQL execution and mutations are real.
vi.mock("../../lib/monaco/monacoLoader", () => ({
    loadMonaco: () => import("../../tests/mocks/fakeMonaco").then(m => m.fakeMonaco),
}));

let fixture: ReturnType<typeof setupSavedPresentation>;
beforeEach(() => {
    fakeMonacoRegistry.reset();
    fixture = setupSavedPresentation();
});
afterEach(async () => {
    cleanup();
    fixture.projectDoc.destroy();
    await resetTableEngineForTests();
});
afterAll(async () => await resetPgliteForTests());

async function mount() {
    const view = render(ProjectGridView, { props: { grid: fixture.grid, projectDoc: fixture.projectDoc } });
    await waitFor(() => expect(view.container.querySelectorAll("tbody tr[data-record-id]")).toHaveLength(2), {
        timeout: 30000,
    });
    await waitFor(() =>
        expect(
            view.container.querySelector('[data-testid="yjs-table-view"]')?.getAttribute("data-mutation-incarnation"),
        )
            .not.toContain(
                "unavailable",
            )
    );
    return view;
}
function cell(container: HTMLElement, id: string, column: string) {
    return container.querySelector(`td[data-record-id='${id}'][data-col='${column}']`)!;
}

describe("MCP-saved Grid presentation in the production runtime (#5436)", () => {
    it("matches the live projection and headless capture to occurrence-specific automatic UNION renderers", {
        timeout: 120000,
    }, async () => {
        fixture.projectDoc.destroy();
        const projectDoc = new Y.Doc({ guid: "grid-projection-union" });
        const choices = getTableHandles(projectDoc, createTable(projectDoc, "Choices", "choices"))!;
        const notes = getTableHandles(projectDoc, createTable(projectDoc, "Notes", "notes"))!;
        setSchemaText(
            choices,
            GRID_OBSERVATION_PARITY.choicesSchema,
        );
        setSchemaText(notes, GRID_OBSERVATION_PARITY.notesSchema);
        addRecord(choices, GRID_OBSERVATION_PARITY.choicesRow, "same");
        addRecord(notes, GRID_OBSERVATION_PARITY.notesRow, "same");
        const { branchA, branchB } = GRID_OBSERVATION_PARITY;
        const grid = getGridHandles(
            projectDoc,
            createGrid(projectDoc, {
                name: "Heterogeneous",
                query: `${branchA} UNION ALL ${branchB} ORDER BY source_kind`,
            }),
        )!;
        setGridComponentField(grid, "source_kind", "hidden", true);
        setGridComponentField(grid, "source_id", "hidden", true);
        setGridComponentField(grid, "hidden", "hidden", true);
        const view = render(ProjectGridView, { props: { grid, projectDoc } });
        try {
            await waitFor(() => expect(view.container.querySelectorAll("tbody tr")).toHaveLength(2), {
                timeout: 30000,
            });
            // PostgreSQL promotes DATE and TIMESTAMP branches to one result
            // OID. The first occurrence uses its accepted DATE field; the
            // second is a computed output with no physical candidate and uses
            // the typed fallback. Tie both controls and projection cells to
            // their occurrences so a source-blind fallback cannot pass.
            const dateCell = view.container.querySelector("tr[data-record-id='choices:same'] td[data-col='value']")!;
            const textCell = view.container.querySelector("tr[data-record-id='notes:same'] td[data-col='value']")!;
            await waitFor(() => expect(dateCell.querySelector("input[type='date']")).toHaveValue("2026-11-21"));
            expect(textCell.querySelector("button")).toHaveTextContent("2026-11-22T12:34:56.000Z");
            const displayedDate = (dateCell.querySelector("input[type='date']") as HTMLInputElement).value;
            const displayedTimestamp = textCell.querySelector("button")!.textContent!;
            expect(displayedTimestamp).not.toBe(displayedDate);
            await waitFor(() => expect(getGridProjection(grid.gridId).status).toBe("ready"));
            const initial = getGridProjection(grid.gridId);
            expect(initial).toMatchObject({
                status: "ready",
                projection: {
                    columns: [{ label: "value" }],
                    rows: [[{ value: displayedDate }], [{ value: displayedTimestamp }]],
                },
            });

            // Cross the real server boundary in the same oracle: seed actual
            // Hocuspocus rooms from the same fixture, execute through PGlite,
            // and compare the retained headless snapshot with the projection
            // whose cells were just observed in the mounted TableGrid DOM.
            const serverDirectory = path.resolve(process.cwd(), "../server");
            const { stdout } = await execFileAsync(process.execPath, [
                "--loader",
                "ts-node/esm",
                "--loader",
                "./tests/loaders/pin-server-deps.mjs",
                "--no-warnings",
                "--input-type=module",
                "-e",
                "import('./tests/view-observation-grid-probe.ts').then(async m => { "
                + "console.log('GRID_PARITY:' + JSON.stringify(await m.captureGridObservationParity())); "
                + "process.exit(0) })",
            ], {
                cwd: serverDirectory,
                timeout: 60_000,
                env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
            });
            const serialized = stdout.split("\n").find(line => line.startsWith("GRID_PARITY:"));
            expect(serialized, stdout).toBeDefined();
            expect(JSON.parse(serialized!.slice("GRID_PARITY:".length))).toEqual(initial.projection);

            // Retain renderer inputs outside equality: an explicit text
            // override changes only the date's displayed normalization.
            setGridComponentField(grid, "value", "type", "text");
            await waitFor(() => expect(view.container.querySelectorAll("td[data-col='value'] button")).toHaveLength(2));
            const textProjection = getGridProjection(grid.gridId);
            if (textProjection.status !== "ready") throw new Error("Expected accepted text projection");
            expect(textProjection.projection.rows).toEqual([
                [{ value: "2026-11-21T00:00:00.000Z" }],
                [{ value: "2026-11-22T12:34:56.000Z" }],
            ]);
            expect(textProjection).not.toEqual(initial); // normalization changed, not merely renderer identity

            // Prove the changed hidden value reached a fresh accepted result,
            // then hide it again and compare only the displayed table content.
            setRecordValue(choices, "same", "hidden", "changed-secret");
            setGridComponentField(grid, "hidden", "hidden", false);
            await waitFor(() =>
                expect(view.container.querySelector("tr[data-record-id='choices:same'] td[data-col='hidden']"))
                    .toHaveTextContent("changed-secret")
            );
            setGridComponentField(grid, "hidden", "hidden", true);
            await waitFor(() => expect(view.container.querySelector("td[data-col='hidden']")).toBeNull());
            await waitFor(() => expect(getGridProjection(grid.gridId)).toEqual(textProjection));

            setRecordValue(notes, "same", "observed_at", "2026-11-23 01:02:03");
            await waitFor(() =>
                expect(getGridProjection(grid.gridId)).toMatchObject({
                    status: "ready",
                    projection: {
                        rows: [
                            [{ value: "2026-11-21T00:00:00.000Z" }],
                            [{ value: "2026-11-23T01:02:03.000Z" }],
                        ],
                    },
                })
            );
            await waitFor(() =>
                expect(
                    view.container.querySelector("tr[data-record-id='notes:same'] td[data-col='value'] button"),
                ).toHaveTextContent("2026-11-23T01:02:03.000Z")
            );
            setRecordValue(notes, "same", "observed_at", "2026-11-22 12:34:56");
            await waitFor(() => expect(getGridProjection(grid.gridId)).toEqual(textProjection));

            // A duplicate occurrence remains independently represented.
            setGridQuery(grid, `${branchA} UNION ALL ${branchA} UNION ALL ${branchB} ORDER BY source_kind`);
            await waitFor(() => expect(view.container.querySelectorAll("tbody tr")).toHaveLength(3));
            await waitFor(() =>
                expect(getGridProjection(grid.gridId)).toMatchObject({
                    status: "ready",
                    projection: {
                        rows: [textProjection.projection.rows[0], textProjection.projection.rows[0],
                            textProjection.projection.rows[1]],
                    },
                })
            );

            // With complete metadata but no row source discriminator, the native OID fallback is authoritative.
            setGridComponentField(grid, "value", "type", undefined);
            setGridQuery(
                grid,
                "SELECT observed_on AS value FROM choices UNION ALL SELECT observed_at AS value FROM notes ORDER BY value",
            );
            await waitFor(() => expect(view.container.querySelectorAll("tbody tr")).toHaveLength(2));
            await waitFor(() => expect(view.container.querySelectorAll("td[data-col='value'] button")).toHaveLength(2));
            expect(view.container.querySelector("td[data-col='value'] input[type='date']")).toBeNull();
            const ambiguousValues = [...GRID_OBSERVATION_PARITY.expectedAmbiguousValues];
            expect([...view.container.querySelectorAll("td[data-col='value'] button")].map(cell => cell.textContent))
                .toEqual(ambiguousValues);
            await waitFor(() =>
                expect(getGridProjection(grid.gridId)).toMatchObject({
                    status: "ready",
                    projection: { rows: ambiguousValues.map(value => [{ value }]) },
                })
            );
            const ambiguousProjection = getGridProjection(grid.gridId);
            setGridComponentField(grid, "value", "type", "text");
            await waitFor(() => expect(getGridProjection(grid.gridId)).toEqual(ambiguousProjection));
            setGridComponentField(grid, "value", "type", undefined);

            // The UI deliberately retains the last successful rows while a
            // replacement query is invalid, but comparable content must not
            // retain the superseded authority. A subsequent accepted result
            // restores publication without remounting the Grid.
            setGridQuery(grid, "SELECT missing_column AS value FROM choices");
            await waitFor(() => expect(getGridProjection(grid.gridId)).toMatchObject({ status: "unavailable" }));
            expect([...view.container.querySelectorAll("td[data-col='value'] button")].map(cell => cell.textContent))
                .toEqual(ambiguousValues);
            setRecordValue(notes, "same", "observed_at", "2026-11-24 04:05:06");
            setGridQuery(
                grid,
                "SELECT observed_on AS value FROM choices UNION ALL SELECT observed_at AS value FROM notes ORDER BY value",
            );
            const recoveredValues = ["2026-11-21T00:00:00.000Z", "2026-11-24T04:05:06.000Z"];
            await waitFor(() =>
                expect(getGridProjection(grid.gridId)).toMatchObject({
                    status: "ready",
                    projection: { rows: recoveredValues.map(value => [{ value }]) },
                })
            );
            await waitFor(() =>
                expect(
                    [...view.container.querySelectorAll("td[data-col='value'] button")].map(cell => cell.textContent),
                )
                    .toEqual(recoveredValues)
            );
        } finally {
            view.unmount();
            projectDoc.destroy();
        }
        expect(getGridProjection(grid.gridId)).toMatchObject({ status: "unavailable" });
    });

    it("keeps physical UNION fields occurrence-aligned across accepted results", { timeout: 60000 }, async () => {
        fixture.projectDoc.destroy();
        const projectDoc = new Y.Doc({ guid: "grid-projection-physical-union" });
        const choices = getTableHandles(projectDoc, createTable(projectDoc, "Choices", "choices"))!;
        const notes = getTableHandles(projectDoc, createTable(projectDoc, "Notes", "notes"))!;
        setSchemaText(choices, "CREATE TABLE choices (id TEXT PRIMARY KEY, observed_on DATE NOT NULL)");
        setSchemaText(notes, "CREATE TABLE notes (id TEXT PRIMARY KEY, observed_at TIMESTAMP NOT NULL)");
        addRecord(choices, { observed_on: "2026-11-21" }, "same");
        addRecord(notes, { observed_at: "2026-11-22 12:34:56" }, "same");
        const grid = getGridHandles(
            projectDoc,
            createGrid(projectDoc, {
                name: "Physical fields",
                query: "SELECT 'choices' AS source_kind, id AS source_id, observed_on AS value FROM choices "
                    + "UNION ALL SELECT 'notes' AS source_kind, id AS source_id, observed_at AS value FROM notes "
                    + "ORDER BY source_kind",
            }),
        )!;
        setGridComponentField(grid, "source_kind", "hidden", true);
        setGridComponentField(grid, "source_id", "hidden", true);
        const view = render(ProjectGridView, { props: { grid, projectDoc } });
        try {
            await waitFor(() => expect(view.container.querySelectorAll("tbody tr")).toHaveLength(2), {
                timeout: 30000,
            });
            const choiceValue = view.container.querySelector(
                "tr[data-record-id='choices:same'] td[data-col='value']",
            )!;
            const noteValue = view.container.querySelector(
                "tr[data-record-id='notes:same'] td[data-col='value']",
            )!;
            await waitFor(() => expect(choiceValue.querySelector("input[type='date']")).toHaveValue("2026-11-21"));
            expect(noteValue.querySelector("button")).toHaveTextContent("2026-11-22T12:34:56.000Z");
            await waitFor(() =>
                expect(getGridProjection(grid.gridId)).toMatchObject({
                    status: "ready",
                    projection: {
                        rows: [[{ value: "2026-11-21" }], [{ value: "2026-11-22T12:34:56.000Z" }]],
                    },
                })
            );

            setRecordValue(choices, "same", "observed_on", "2026-11-25");
            setRecordValue(notes, "same", "observed_at", "2026-11-26 04:05:06");
            await waitFor(() => expect(choiceValue.querySelector("input[type='date']")).toHaveValue("2026-11-25"));
            await waitFor(() =>
                expect(noteValue.querySelector("button")).toHaveTextContent("2026-11-26T04:05:06.000Z")
            );
            await waitFor(() =>
                expect(getGridProjection(grid.gridId)).toMatchObject({
                    status: "ready",
                    projection: {
                        rows: [[{ value: "2026-11-25" }], [{ value: "2026-11-26T04:05:06.000Z" }]],
                    },
                })
            );
            const changedProjection = getGridProjection(grid.gridId);
            deleteRecord(notes, "same");
            addRecord(notes, { observed_at: "2026-11-26 04:05:06" }, "replacement");
            await waitFor(() =>
                expect(
                    view.container.querySelector("tr[data-record-id='notes:replacement'] td[data-col='value'] button"),
                ).toHaveTextContent("2026-11-26T04:05:06.000Z")
            );
            await waitFor(() => expect(getGridProjection(grid.gridId)).toEqual(changedProjection));
        } finally {
            view.unmount();
            projectDoc.destroy();
        }
    });

    it("round-trips Japanese labels, visibility, exact column identities and SQL row order in two placements", async () => {
        const first = await mount();
        const second = await mount();
        for (const { container } of [first, second]) {
            expect([...container.querySelectorAll("th[data-col] .th-label")].map(th => th.textContent?.trim()))
                .toEqual(["完了", "期限", "title"]);
            expect(container.querySelector("th[data-col='id']")).toBeNull();
            expect(container.querySelector("[data-col='期限']")).toBeNull();
            expect(container.querySelector("th[data-col='done']")).toHaveAttribute("title", "done");
            expect(container.querySelector("th[data-col='due_date']")).toHaveAttribute("title", "due_date");
            expect(
                [...container.querySelectorAll("tbody tr[data-record-id]")].map(row =>
                    row.getAttribute("data-record-id")
                ),
            )
                .toEqual(["r2", "r1"]);
            expect(
                [...container.querySelectorAll("tbody tr:first-child td[data-col]")].map(td =>
                    td.getAttribute("data-col")
                ),
            )
                .toEqual(["done", "due_date", "title"]);
        }
    });

    it("keeps the remaining placement registered when the newest placement unmounts", async () => {
        const first = await mount();
        const second = await mount();
        await waitFor(() => expect(getGridProjection(fixture.grid.gridId).status).toBe("ready"));
        second.unmount();
        await waitFor(() => expect(getGridProjection(fixture.grid.gridId).status).toBe("ready"));
        setRecordValue(fixture.handles, "r1", "title", "Write revised report");
        await waitFor(() => expect(cell(first.container, "r1", "title")).toHaveTextContent("Write revised report"));
        await waitFor(() =>
            expect(getGridProjection(fixture.grid.gridId)).toMatchObject({
                status: "ready",
                projection: {
                    rows: expect.arrayContaining([expect.arrayContaining([{ value: "Write revised report" }])]),
                },
            })
        );
    });

    it("shows saved settings in the real definition editor under result names", async () => {
        const view = await mount();
        await fireEvent.click(view.getByTestId("yjs-table-toggle-ui"));
        expect(view.getByTestId("yjs-table-label-due_date")).toHaveValue("期限");
        expect(view.getByTestId("yjs-table-label-done")).toHaveValue("完了");
        expect(view.getByTestId("yjs-table-component-done")).toHaveValue("checkbox");
        expect(view.getByTestId("yjs-table-component-due_date")).toHaveValue("auto");
        expect(view.getByTestId("yjs-table-hidden-id")).not.toBeChecked();
        expect(view.getByTestId("yjs-table-hidden-due_date")).toBeChecked();
        expect([...view.container.querySelectorAll(".component-row")].map(row => row.getAttribute("data-col")))
            .toEqual(["done", "due_date", "id", "title"]);
    });

    it("uses current physical metadata when an explicit renderer is reset to automatic", async () => {
        const view = await mount();
        expect(cell(view.container, "r1", "done").querySelector("input[type='checkbox']")).not.toBeNull();
        expect(cell(view.container, "r1", "due_date").querySelector("input[type='date']")).toHaveValue("2026-10-31");
        setGridComponentField(fixture.grid, "done", "type", "text");
        await waitFor(() => expect(cell(view.container, "r1", "done").querySelector("button")).not.toBeNull());
        setGridComponentField(fixture.grid, "done", "type", undefined);
        await waitFor(() =>
            expect(cell(view.container, "r1", "done").querySelector("input[type='checkbox']")).toBeEnabled()
        );
    });

    it("honors Add and delete-confirmation settings without granting write authority", async () => {
        const view = await mount();
        expect(view.queryByTestId("yjs-table-add-row")).toBeNull();
        await fireEvent.click(view.getByRole("button", { name: /^Delete row r1$/ }));
        expect(view.container.textContent).toContain("Are you sure you want to delete row r1?");
        await fireEvent.click(view.getByText("Cancel", { selector: "button" }));
        expect(fixture.handles.data.get("r1")?.get("done")).toBe(false);
        expect(fixture.handles.data.size).toBe(2);
    });

    it("commits the second displayed row's relabeled checkbox to its physical record only", async () => {
        const view = await mount();
        const checkbox = cell(view.container, "r1", "done").querySelector<HTMLInputElement>("input[type='checkbox']")!;
        await waitFor(() => expect(checkbox).toBeEnabled());
        const before = fixture.handles.schemaText.toString();
        await fireEvent.focus(checkbox);
        await fireEvent.click(checkbox);
        await waitFor(() => expect(fixture.handles.data.get("r1")?.get("done")).toBe(true));
        expect(fixture.handles.data.get("r1")?.has("完了")).toBe(false);
        expect(fixture.handles.data.get("r1")?.get("title")).toBe("Write report");
        expect(fixture.handles.data.get("r2")?.toJSON()).toEqual({
            id: "r2",
            title: "Pay bills",
            due_date: "2026-11-30",
            done: true,
        });
        expect(fixture.handles.schemaText.toString()).toBe(before);
        expect(readGridComponents(getGridHandles(fixture.projectDoc, fixture.separateId)!)).toEqual(
            fixture.separateBefore,
        );
    });

    it("keeps DISTINCT results read-only using their own current producer evidence", async () => {
        setGridQuery(fixture.grid, QUERY.replace("SELECT ", "SELECT DISTINCT "));
        const before = fixture.handles.data.toJSON();
        const view = await mount();
        expect(view.getByTestId("grid-readonly-reason")).toBeVisible();
        for (const checkbox of view.container.querySelectorAll("td[data-col='done'] input")) {
            expect(checkbox).toBeDisabled();
        }
        expect(fixture.handles.data.toJSON()).toEqual(before);
        expect(readGridComponents(fixture.grid).labels).toMatchObject({ done: "完了", due_date: "期限" });
    });
});
