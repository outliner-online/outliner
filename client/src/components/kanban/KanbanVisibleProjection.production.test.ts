import { render, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createKanban, getKanbanHandles, updateKanban } from "../../services/yjstable/kanbanDocs";
import type { KanbanProjection } from "../../services/yjstable/kanbanQueryRunner";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { addRecord, createTable, getTableHandles, setSchemaText } from "../../services/yjstable/tableDocs";
import type { TableDocConnector } from "../../services/yjstable/tableEngine";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import KanbanBoard from "./KanbanBoard.svelte";

afterEach(async () => resetTableEngineForTests());
afterAll(async () => resetPgliteForTests());

describe("production Kanban visible projection", { timeout: 30000 }, () => {
    it("matches the real board across special/empty lanes, duplicates, and a fresh execution identity", async () => {
        const projectDoc = new Y.Doc({ guid: `kanban-visible-${crypto.randomUUID()}` });
        const tableId = createTable(projectDoc, "Tasks", "tasks");
        const table = getTableHandles(projectDoc, tableId)!;
        setSchemaText(
            table,
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT CHECK (status IN ('todo', 'done', '', ' ')), detail TEXT)",
        );
        addRecord(table, { title: null, status: null, detail: undefined }, "null");
        addRecord(table, { title: "", status: "", detail: null }, "empty");
        addRecord(table, { title: "Same", status: " ", detail: "x" }, "space-a");
        addRecord(table, { title: "Same", status: " ", detail: "x" }, "space-b");
        addRecord(table, { title: "Todo", status: "todo", detail: "shown" }, "todo");
        const query = "SELECT id, title, status, detail FROM tasks ORDER BY id";
        const kanbanId = createKanban(projectDoc, {
            name: "Production board",
            query,
            groupField: "status",
            titleField: "title",
            detailFields: ["detail"],
            laneOrder: ["done", null],
        });
        let latest: KanbanProjection | undefined;
        const view = render(KanbanBoard, {
            props: {
                projectDoc,
                kanban: getKanbanHandles(projectDoc, kanbanId)!,
                context: { version: 1, surface: "board", locale: "en-US", timeZone: "UTC" },
                onProjection: value => latest = value,
                connect: localConnector,
            },
        });

        await waitFor(() => expect(latest?.visible?.status).toBe("ready"), { timeout: 15000 });
        const first = latest!;
        expect(first.current).toBe(true);
        expect(first.provenance?.evidence?.queryId).toBeTruthy();
        expect(first.visible?.status === "ready" && first.visible.content.lanes).toEqual(readBoard(view.container));
        expect(first.visible?.status === "ready" && first.visible.content.lanes.map(lane => lane.label)).toEqual([
            "done",
            "SQL NULL",
            "todo",
            "Empty string",
            "Whitespace (1)",
        ]);
        expect(
            first.visible?.status === "ready" && first.visible.content.lanes.find(lane => lane.label === "done")?.cards,
        )
            .toEqual([]);
        expect(
            first.visible?.status === "ready"
                && first.visible.content.lanes.find(lane => lane.label === "Whitespace (1)")?.cards,
        )
            .toHaveLength(2);

        const firstContent = first.visible;
        const firstQueryId = first.provenance!.evidence!.queryId;
        const firstOccurrences = first.lanes.flatMap(lane => lane.cards.map(card => card.occurrenceKey));
        updateKanban(projectDoc, kanbanId, { query: `${query} ` });
        await waitFor(() => expect(latest?.provenance?.evidence?.queryId).not.toBe(firstQueryId), { timeout: 15000 });
        expect(latest?.visible).toEqual(firstContent);
        expect(latest?.lanes.flatMap(lane => lane.cards.map(card => card.occurrenceKey))).not.toEqual(firstOccurrences);
        expect(latest?.visible?.status === "ready" && latest.visible.content.lanes).toEqual(readBoard(view.container));
        view.unmount();
    });
});

const localConnector: TableDocConnector = async () => ({
    waitForInitialSync: async () => ({ synced: true }),
    dispose: () => {},
});

function readBoard(container: HTMLElement) {
    return [...container.querySelectorAll<HTMLElement>("section.lane")].map(lane => ({
        label: lane.querySelector("h2 span")?.textContent ?? "",
        kindLabel: lane.querySelector("h2 .lane-kind")?.textContent ?? "",
        cards: [...lane.querySelectorAll<HTMLElement>("article.card")].map(card => ({
            title: card.querySelector("h3 .field-value, h3")?.textContent?.trim() ?? "",
            details: [...card.querySelectorAll<HTMLElement>(".detail")].map(detail => ({
                label: detail.querySelector("strong")?.textContent ?? "",
                value: detail.querySelector(".field-value")?.textContent ?? "",
            })),
        })),
    }));
}
