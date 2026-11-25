import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const routeState = vi.hoisted(() => ({
    docsById: new Map<string, unknown>(),
    docsByTitle: new Map<string, unknown>(),
    openById: vi.fn<(key: string) => void>(),
    openByTitle: vi.fn<(key: string) => void>(),
}));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("../AuthComponent.svelte", () => import("../../tests/fixtures/AuthComponentProbe.svelte"));
vi.mock("../../auth/UserManager", () => ({
    userManager: {
        getCurrentUser: () => ({ uid: "authorized-user" }),
        addEventListener: () => () => {},
    },
}));
vi.mock("../../lib/routeProject", async () => {
    const { store } = await import("../../stores/store.svelte");
    const { yjsStore } = await import("../../stores/yjsStore.svelte");
    const open =
        (docs: Map<string, unknown>, tracker: (key: string) => void) => async (key: string, isStale: () => boolean) => {
            // Match the real network-backed opener's asynchronous boundary so
            // store publication is not captured as a dependency of the view's
            // route-loading effect.
            await Promise.resolve();
            tracker(key);
            if (isStale()) return undefined;
            const ydoc = docs.get(key) as Y.Doc | undefined;
            if (!ydoc) return undefined;
            store.project = { ydoc } as NonNullable<typeof store.project>;
            yjsStore.yjsClient = {
                containerId: key,
                getProject: () => store.project,
            } as NonNullable<typeof yjsStore.yjsClient>;
            return { projectId: key, release: vi.fn() };
        };
    return {
        openRouteProject: open(routeState.docsByTitle, routeState.openByTitle),
        openRouteProjectById: open(routeState.docsById, routeState.openById),
    };
});
vi.mock("../kanban/KanbanBoard.svelte", () => import("../../tests/fixtures/KanbanBoardProbe.svelte"));

import { createKanban } from "../../services/yjstable/kanbanDocs";
import { store } from "../../stores/store.svelte";
import KanbanDetailView from "./KanbanDetailView.svelte";

describe("Kanban observation route navigation", () => {
    beforeEach(() => {
        routeState.docsById.clear();
        routeState.docsByTitle.clear();
        routeState.openById.mockClear();
        routeState.openByTitle.mockClear();
        store.project = undefined;
    });
    afterEach(cleanup);

    it("opens a non-UUID observation project strictly by ID despite a title collision", async () => {
        const projectId = "saved-project-id";
        const target = new Y.Doc({ guid: "exact-project-document" });
        const collision = new Y.Doc({ guid: "title-collision-document" });
        const kanbanId = createKanban(target, {
            name: "Saved Board",
            query: "SELECT 1 AS status",
            groupField: "status",
        });
        createKanban(collision, { kanbanId, name: "Wrong Board", query: "SELECT 2 AS status", groupField: "status" });
        routeState.docsById.set(projectId, target);
        routeState.docsByTitle.set(projectId, collision);
        const context = { version: 1, surface: "board", locale: "ja-JP", timeZone: "Asia/Tokyo" } as const;

        render(KanbanDetailView, { projectName: projectId, kanbanId, observationContext: context });

        await waitFor(() =>
            expect(screen.getByTestId("kanban-board-probe").textContent).toBe(
                "exact-project-document:ja-JP:Asia/Tokyo",
            )
        );
        expect(routeState.openById).toHaveBeenCalledWith(projectId);
        expect(routeState.openByTitle).not.toHaveBeenCalled();
        expect(screen.getByRole("heading", { level: 1 }).textContent?.trim()).toBe("Saved Board");
    });
});
