import { expect, type Locator, type Page } from "@playwright/test";
import { readGridProjectState } from "./crossProjectGridHelpers";

interface ObservableDoc {
    on: (event: string, callback: () => void) => void;
    off: (event: string, callback: () => void) => void;
}

interface TouchProbeBrowser {
    __YJS_STORE__: {
        yjsClient: {
            getProject: () => {
                ydoc: ObservableDoc & {
                    getMap: (name: string) => {
                        values: () => IterableIterator<{ get: (name: string) => ObservableDoc; }>;
                        toJSON: () => unknown;
                    };
                };
            };
        };
    };
    globalUndoRouter: { undoDepth: number; redoDepth: number; };
    generalStore: { undoManager: ObservableDoc & { undoStack: unknown[]; redoStack: unknown[]; }; };
    __touchNavigationProbe: { updates: number; historyEvents: number; editorEntries: number; stop: () => void; };
}

/** Observe the real documents/history and native editor boundary, never replace their writers. */
export async function observeTouchNavigationOnly(page: Page, grid: Locator): Promise<() => Promise<void>> {
    const saved = await readGridProjectState(page);
    const before = await page.evaluate(() => {
        const g = globalThis as unknown as TouchProbeBrowser;
        return {
            outline: g.__YJS_STORE__.yjsClient.getProject().ydoc.getMap("orderedTree").toJSON(),
            history: [g.globalUndoRouter.undoDepth, g.globalUndoRouter.redoDepth,
                g.generalStore.undoManager.undoStack.length, g.generalStore.undoManager.redoStack.length],
        };
    });
    for (const depth of before.history) expect(depth).toBeGreaterThanOrEqual(0);
    await expect(grid.locator(".cell-input")).toHaveCount(0);
    await grid.evaluate(node => {
        const g = globalThis as unknown as TouchProbeBrowser;
        const project = g.__YJS_STORE__.yjsClient.getProject();
        const documents: ObservableDoc[] = [project.ydoc];
        for (const table of project.ydoc.getMap("yjsTables").values()) documents.push(table.get("doc"));
        if (documents.length < 2) throw new Error("Real table document missing from touch invariant probe");
        const probe = { updates: 0, historyEvents: 0, editorEntries: 0, stop: () => {} };
        const onUpdate = () => probe.updates++;
        const onHistory = () => probe.historyEvents++;
        const historyEvents = ["stack-item-added", "stack-item-updated", "stack-item-popped", "stack-cleared"];
        for (const doc of documents) doc.on("update", onUpdate);
        for (const event of historyEvents) g.generalStore.undoManager.on(event, onHistory);
        const onFocus = (event: Event) => {
            if (
                event.target instanceof Element && event.target.closest("td")
                && event.target.matches("input, textarea, select, [contenteditable='true']")
            ) probe.editorEntries++;
        };
        node.addEventListener("focusin", onFocus);
        const observer = new MutationObserver(records => {
            for (const record of records) {
                for (const added of record.addedNodes) {
                    if (
                        added instanceof Element
                        && (added.matches(".cell-input") || added.querySelector(".cell-input"))
                    ) probe.editorEntries++;
                }
            }
        });
        observer.observe(node, { childList: true, subtree: true });
        probe.stop = () => {
            for (const doc of documents) doc.off("update", onUpdate);
            for (const event of historyEvents) g.generalStore.undoManager.off(event, onHistory);
            node.removeEventListener("focusin", onFocus);
            observer.disconnect();
        };
        g.__touchNavigationProbe = probe;
    });
    return async () => {
        const after = await page.evaluate(() => {
            const g = globalThis as unknown as TouchProbeBrowser;
            const probe = g.__touchNavigationProbe;
            probe.stop();
            return {
                outline: g.__YJS_STORE__.yjsClient.getProject().ydoc.getMap("orderedTree").toJSON(),
                history: [g.globalUndoRouter.undoDepth, g.globalUndoRouter.redoDepth,
                    g.generalStore.undoManager.undoStack.length, g.generalStore.undoManager.redoStack.length],
                updates: probe.updates,
                historyEvents: probe.historyEvents,
                editorEntries: probe.editorEntries,
            };
        });
        expect(after.updates, "handle navigation must not emit project/table Yjs updates").toBe(0);
        expect(after.historyEvents, "handle navigation must not alter Undo history").toBe(0);
        expect(after.editorEntries, "handle navigation must not enter a native cell editor").toBe(0);
        expect(after.history).toEqual(before.history);
        expect(after.outline).toEqual(before.outline);
        expect(await readGridProjectState(page)).toEqual(saved);
        await expect(grid.locator(".cell-input")).toHaveCount(0);
    };
}
