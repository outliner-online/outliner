import { render, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createKanban, getKanbanHandles, updateKanban } from "../../services/yjstable/kanbanDocs";
import type { KanbanProjection } from "../../services/yjstable/kanbanQueryRunner";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import {
    addRecord,
    createTable,
    getTableHandles,
    setRecordValue,
    setSchemaText,
} from "../../services/yjstable/tableDocs";
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
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT CHECK (status IN ('todo', 'done', '', ' ')), detail TEXT, hidden TEXT)",
        );
        addRecord(table, { title: null, status: null, detail: undefined, hidden: "a" }, "null");
        addRecord(table, { title: "", status: "", detail: null, hidden: "b" }, "empty");
        addRecord(table, { title: "Same", status: " ", detail: "x", hidden: "c" }, "space-a");
        addRecord(table, { title: "Same", status: " ", detail: "x", hidden: "d" }, "space-b");
        addRecord(table, { title: "Todo", status: "todo", detail: "shown", hidden: "before" }, "todo");
        const query = "SELECT id, title, status, detail, hidden FROM tasks ORDER BY id";
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

        setRecordValue(table, "todo", "title", "Todo updated");
        await waitFor(() => expect(latest?.provenance?.evidence?.queryId).not.toBe(firstQueryId), { timeout: 15000 });
        expect(latest?.visible).not.toEqual(firstContent);
        expect(latest?.visible?.status === "ready" && latest.visible.content.lanes).toEqual(readBoard(view.container));
        expect(view.getByText("Todo updated")).toBeInTheDocument();

        const displayedEditContent = latest!.visible;
        const displayedEditQueryId = latest!.provenance!.evidence!.queryId;
        expect(latest?.result?.rows.find(row => row.id === "todo")?.hidden).toBe("before");
        setRecordValue(table, "todo", "hidden", "after");
        await waitFor(() => {
            expect(latest?.provenance?.evidence?.queryId).not.toBe(displayedEditQueryId);
            expect(latest?.result?.rows.find(row => row.id === "todo")?.hidden).toBe("after");
        }, { timeout: 15000 });
        expect(latest?.visible).toEqual(displayedEditContent);
        expect(latest?.visible?.status === "ready" && latest.visible.content.lanes).toEqual(readBoard(view.container));

        const sourceEditQueryId = latest!.provenance!.evidence!.queryId;
        updateKanban(projectDoc, kanbanId, { query: `${query} ` });
        await waitFor(() => expect(latest?.provenance?.evidence?.queryId).not.toBe(sourceEditQueryId), {
            timeout: 15000,
        });
        expect(latest?.visible).toEqual(displayedEditContent);
        expect(latest?.lanes.flatMap(lane => lane.cards.map(card => card.occurrenceKey))).not.toEqual(firstOccurrences);
        expect(latest?.visible?.status === "ready" && latest.visible.content.lanes).toEqual(readBoard(view.container));

        updateKanban(projectDoc, kanbanId, {
            query: "SELECT id, title, detail, hidden FROM tasks ORDER BY id",
        });
        await waitFor(() => expect(latest?.status).toBe("invalid"), { timeout: 15000 });
        expect(latest).toMatchObject({
            current: false,
            lanes: [],
            visible: {
                status: "non-ready",
                reason: 'Grouping result column "status" is missing',
            },
        });
        expect("content" in latest!.visible!).toBe(false);

        updateKanban(projectDoc, kanbanId, { query: `${query.replace("ORDER BY", "WHERE false ORDER BY")}` });
        await waitFor(() => {
            expect(latest?.status).toBe("success");
            expect(latest?.current).toBe(true);
            expect(latest?.visible?.status).toBe("ready");
        }, {
            timeout: 15000,
        });
        expect(view.getByTestId("kanban-empty")).toHaveTextContent("The query returned no cards.");
        expect(latest?.lanes.every(lane => lane.cards.length === 0)).toBe(true);
        expect(readBoard(view.container).map(lane => lane.label)).toEqual([
            "done",
            "todo",
            "Empty string",
            "Whitespace (1)",
        ]);
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
