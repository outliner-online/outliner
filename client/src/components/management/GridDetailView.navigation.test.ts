import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const routeState = vi.hoisted(() => ({
    docsById: new Map<string, unknown>(),
    docsByTitle: new Map<string, unknown>(),
    openById: vi.fn<(key: string) => void>(),
    openByTitle: vi.fn<(key: string) => void>(),
    titleCompleted: vi.fn<() => void>(),
    holdTitle: undefined as Promise<void> | undefined,
}));
vi.mock("$app/state", () => import("../../tests/mocks/appState.svelte"));
vi.mock("../AuthComponent.svelte", () => import("../../tests/fixtures/AuthComponentProbe.svelte"));
vi.mock("../../auth/UserManager", () => ({
    userManager: { getCurrentUser: () => ({ uid: "owner" }), addEventListener: () => () => {} },
}));
vi.mock("../../stores/projectStore.svelte", () => ({
    projectStore: { isLoaded: true, projects: [{ id: "saved-project-id" }, { id: "title-collision-id" }] },
}));
// Substitute network admission only; the saved Grid and its SQL renderer stay real.
vi.mock("../../lib/routeProject", async () => {
    const { store } = await import("../../stores/store.svelte");
    const { yjsStore } = await import("../../stores/yjsStore.svelte");
    const open =
        (docs: Map<string, unknown>, tracker: typeof routeState.openById, byTitle = false) =>
        async (key: string, isStale: () => boolean) => {
            const doc = docs.get(key) as Y.Doc | undefined;
            tracker(key);
            await Promise.resolve();
            if (byTitle) {
                await routeState.holdTitle;
                routeState.titleCompleted();
            }
            if (!doc || isStale()) return undefined;
            store.project = { ydoc: doc } as NonNullable<typeof store.project>;
            yjsStore.yjsClient = {
                containerId: doc.guid,
                getProject: () => store.project,
            } as NonNullable<typeof yjsStore.yjsClient>;
            return { projectId: doc.guid, release: vi.fn() };
        };
    return {
        openRouteProject: open(routeState.docsByTitle, routeState.openByTitle, true),
        openRouteProjectById: open(routeState.docsById, routeState.openById),
    };
});
vi.mock("../../lib/monaco/monacoLoader", () => ({
    loadMonaco: () => import("../../tests/mocks/fakeMonaco").then(module => module.fakeMonaco),
}));

import GridStandalonePage from "../../routes/[project]/-/grids/[gridId]/+page.svelte";
import { createGrid } from "../../services/yjstable/gridDocs";
import { resetPgliteForTests } from "../../services/yjstable/pgliteService";
import { resetTableEngineForTests } from "../../services/yjstable/tableEngine";
import { store } from "../../stores/store.svelte";
import { setPage } from "../../tests/mocks/appState.svelte";

const ordinaryUrl = "http://localhost/saved-project-id/-/grids/grid-a";
const observationUrl = () => {
    const url = new URL(ordinaryUrl);
    url.searchParams.set("observation", JSON.stringify({
        version: 1,
        surface: "table",
        locale: "en-US",
        timeZone: "UTC",
    }));
    return url;
};
const cellText = () => screen.getByTestId("yjs-table-view").querySelector('td[data-col="value"] button')?.textContent;

describe("Grid observation navigation on an existing route", { timeout: 60_000 }, () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routeState.holdTitle = undefined;
        store.project = undefined;
        const exact = new Y.Doc({ guid: "saved-project-id" });
        const collision = new Y.Doc({ guid: "title-collision-id" });
        createGrid(exact, { gridId: "grid-a", name: "Exact Grid", query: "SELECT 42 AS value" });
        createGrid(collision, { gridId: "grid-a", name: "Title Grid", query: "SELECT 7 AS value" });
        routeState.docsById.set("saved-project-id", exact);
        routeState.docsByTitle.set("saved-project-id", collision);
        setPage({ params: { project: "saved-project-id", gridId: "grid-a" }, url: ordinaryUrl });
    });
    afterEach(async () => {
        cleanup();
        for (const doc of [...routeState.docsById.values(), ...routeState.docsByTitle.values()]) {
            (doc as Y.Doc).destroy();
        }
        routeState.docsById.clear();
        routeState.docsByTitle.clear();
        await resetTableEngineForTests();
    });
    afterAll(resetPgliteForTests);

    it("switches between title and exact-ID admission when only the observation query changes", async () => {
        render(GridStandalonePage);
        await waitFor(() => expect(cellText()).toBe("7"), { timeout: 30_000 });
        expect(routeState.openById).not.toHaveBeenCalled();

        setPage({ url: observationUrl() });
        await waitFor(() => expect(cellText()).toBe("42"), { timeout: 30_000 });
        expect(routeState.openById).toHaveBeenCalledWith("saved-project-id");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Exact Grid");

        setPage({ url: ordinaryUrl });
        await waitFor(() => expect(cellText()).toBe("7"), { timeout: 30_000 });
        expect(routeState.openByTitle).toHaveBeenCalledTimes(2);
    });

    it("rejects a pending title admission after navigation selects an observation target", async () => {
        let releaseTitle!: () => void;
        routeState.holdTitle = new Promise<void>(resolve => releaseTitle = resolve);
        render(GridStandalonePage);
        try {
            await waitFor(() => expect(routeState.openByTitle).toHaveBeenCalledTimes(1));
            setPage({ url: observationUrl() });
            await waitFor(() => expect(cellText()).toBe("42"), { timeout: 30_000 });
            releaseTitle();
            await waitFor(() => expect(routeState.titleCompleted).toHaveBeenCalledTimes(1));
            expect(store.project?.ydoc.guid).toBe("saved-project-id");
            expect(cellText()).toBe("42");
            expect(screen.queryByText("Grid not found")).toBeNull();
        } finally {
            releaseTitle();
        }
    });
});
