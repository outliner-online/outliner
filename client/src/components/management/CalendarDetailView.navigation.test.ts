import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const routeState = vi.hoisted(() => ({
    docs: new Map<string, unknown>(),
    pending: new Map<string, () => void>(),
}));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("../../auth/UserManager", () => ({
    userManager: {
        getCurrentUser: () => ({ uid: "authorized-user" }),
        addEventListener: () => () => {},
    },
}));
vi.mock("../../lib/demoInit", () => ({
    DemoInitAborted: class DemoInitAborted extends Error {},
}));
vi.mock("../../lib/routeProject", async () => {
    const { store } = await import("../../stores/store.svelte");
    const { yjsStore } = await import("../../stores/yjsStore.svelte");
    const open = vi.fn((projectName: string, isStale: () => boolean) =>
        new Promise(resolve => {
            routeState.pending.set(projectName, () => {
                if (isStale()) {
                    resolve(undefined);
                    return;
                }
                const ydoc = routeState.docs.get(projectName) as Y.Doc;
                store.project = { ydoc } as NonNullable<typeof store.project>;
                yjsStore.yjsClient = {
                    containerId: projectName,
                    getProject: () => store.project,
                } as NonNullable<typeof yjsStore.yjsClient>;
                resolve({ projectId: projectName, release: vi.fn() });
            });
        })
    );
    return {
        openRouteProject: open,
        openRouteProjectById: open,
    };
});

vi.mock("../calendar/CalendarView.svelte", () => import("../../tests/fixtures/CalendarViewProbe.svelte"));

import { Project } from "$shared/app-schema";
import { computeViewRange } from "../../services/calendar/calendarGridRange";
import { createCalendar } from "../../services/calendar/calendarService";
import { store } from "../../stores/store.svelte";
import CalendarDetailView from "./CalendarDetailView.svelte";

function projectWithCalendar(guid: string, idName: string): { doc: Y.Doc; calendarId: string; } {
    const doc = new Y.Doc({ guid });
    const calendarId = createCalendar(Project.fromDoc(doc), {
        name: idName,
        query: "SELECT 1 AS id",
        viewType: "day",
        groupAxes: [],
    });
    return { doc, calendarId };
}

function observationContext() {
    const anchorUtcMs = Date.UTC(2026, 10, 21, 12);
    const range = computeViewRange(anchorUtcMs, "day", 1, "UTC");
    return {
        version: 1 as const,
        locale: "en-US",
        timeZone: "UTC",
        weekStart: 1,
        viewType: "day" as const,
        anchorUtcMs,
        rangeStartUtcMs: range.start,
        rangeEndUtcMs: range.end,
        monthLaneFilter: null,
        collapsedEntryKeys: [],
    };
}

describe("Calendar observation route navigation", () => {
    beforeEach(() => {
        routeState.docs.clear();
        routeState.pending.clear();
        store.project = undefined;
    });

    afterEach(cleanup);

    it("ignores a previous authorized project open that finishes after the newer route", async () => {
        const oldProject = projectWithCalendar("old-project-doc", "Old Calendar");
        const newProject = projectWithCalendar("new-project-doc", "New Calendar");
        routeState.docs.set("old-project-id", oldProject.doc);
        routeState.docs.set("new-project-id", newProject.doc);

        const view = render(CalendarDetailView, {
            projectName: "old-project-id",
            calendarName: oldProject.calendarId,
            observationContext: observationContext(),
        });
        await waitFor(() => expect(routeState.pending.has("old-project-id")).toBe(true));

        await view.rerender({
            projectName: "new-project-id",
            calendarName: newProject.calendarId,
            observationContext: observationContext(),
        });
        await waitFor(() => expect(routeState.pending.has("new-project-id")).toBe(true));
        routeState.pending.get("new-project-id")!();

        await waitFor(() =>
            expect(screen.getByTestId("calendar-view-probe").textContent).toContain(
                `new-project-doc:${newProject.calendarId}`,
            )
        );
        routeState.pending.get("old-project-id")!();

        await waitFor(() => {
            expect(screen.getByTestId("calendar-view-probe").textContent).toContain(
                `new-project-doc:${newProject.calendarId}`,
            );
            expect(screen.getByRole("heading", { level: 1 }).textContent?.trim()).toBe("New Calendar");
            expect(screen.queryByText("Old Calendar")).toBeNull();
            expect(screen.queryByText("Calendar not found")).toBeNull();
            expect(screen.queryByText("An error occurred")).toBeNull();
            expect(store.project?.ydoc.guid).toBe("new-project-doc");
        });
    });

    it("resolves a demo observation Calendar strictly by ID despite a matching name", async () => {
        const doc = new Y.Doc({ guid: "demo" });
        const project = Project.fromDoc(doc);
        const targetId = createCalendar(project, {
            name: "Target Calendar",
            query: "SELECT 1 AS id",
            viewType: "day",
            groupAxes: [],
        });
        createCalendar(project, {
            name: targetId,
            query: "SELECT 2 AS id",
            viewType: "day",
            groupAxes: [],
        });
        routeState.docs.set("demo", doc);

        render(CalendarDetailView, {
            projectName: "demo",
            calendarName: targetId,
            observationContext: observationContext(),
        });
        await waitFor(() => expect(routeState.pending.has("demo")).toBe(true));
        routeState.pending.get("demo")!();

        await waitFor(() => {
            expect(screen.getByTestId("calendar-view-probe").textContent).toContain(`demo:${targetId}`);
            expect(screen.getByRole("heading", { level: 1 }).textContent?.trim()).toBe("Target Calendar");
            expect(screen.queryByRole("heading", { name: targetId })).toBeNull();
        });
    });
});
