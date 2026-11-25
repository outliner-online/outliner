import type { Hocuspocus } from "@hocuspocus/server";
import { expect } from "chai";
import request from "supertest";
import * as Y from "yjs";
import type { NotificationRule } from "../../../shared/src/notifications/notification-settings.js";
import { computeViewRange } from "../../../shared/src/services/calendarGridRange.js";
import { createGridEntry } from "../../../shared/src/services/gridDefinition.js";
import { createKanbanEntry } from "../../../shared/src/services/kanbanDefinition.js";
import { NotificationObservationRuntime } from "../../src/notifications/observation-runtime.js";
import type { PreparedViewChange } from "../../src/notifications/prepared-view-change.js";
import { type ReadSnapshotResult, ViewObservationService } from "../../src/notifications/view-observation.js";
import { signAccessToken } from "../../src/oauth/tokens.js";
import { Project } from "../../src/schema/app-schema.js";
import { AclStore, startTestServer, stopTestServer, tempDir, waitFor } from "../server-create-table-fixture.js";

export { deferred, waitFor } from "../server-create-table-fixture.js";
export const UID = "notification-owner";
export const PROJECT = "notification-runtime";
export const gridContext = { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" } as const;
export type RuntimeOptions = NonNullable<ConstructorParameters<typeof NotificationObservationRuntime>[3]>;
export type ObservationHooks = NonNullable<ConstructorParameters<typeof ViewObservationService>[3]>;

export function rule(ruleId = "watch-grid", projectId = PROJECT): NotificationRule {
    return {
        ruleId,
        target: { projectId, kind: "grid", objectId: "watched" },
        enabled: true,
        channels: { mcp: true, mobile: false },
        context: gridContext,
    };
}

export function calendarRule(): NotificationRule {
    const anchorUtcMs = Date.parse("2026-11-21T12:00:00Z");
    const range = computeViewRange(anchorUtcMs, "day", 1, "UTC");
    return {
        ...rule("watch-calendar"),
        target: { projectId: PROJECT, kind: "calendar", objectId: "calendar" },
        context: {
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
        },
    };
}

export function kanbanRule(): NotificationRule {
    return {
        ...rule("watch-kanban"),
        target: { projectId: PROJECT, kind: "kanban", objectId: "board" },
        context: { ...gridContext, surface: "board" },
    };
}

/** All equality decisions come from production PGlite and live Hocuspocus rooms. */
export async function runtimeFixture(
    options: RuntimeOptions = {},
    hooks: ObservationHooks = {},
    directory = tempDir(),
    captureMobile = true,
) {
    const acl = new AclStore();
    acl.grant("projectUsers", PROJECT, UID);
    const server = await startTestServer(directory, acl);
    await (server as typeof server & { notificationRuntime?: NotificationObservationRuntime; }).notificationRuntime
        ?.close();
    const connections: Awaited<ReturnType<typeof seedRuntimeProject>> = [];
    const observations = new ViewObservationService(server.hocuspocus, acl.checkAccess, {}, hooks);
    const reads: { objectId: string; projectId: string; result: ReadSnapshotResult; }[] = [];
    const observing = {
        async openViewObservation(input: Parameters<ViewObservationService["openViewObservation"]>[0]) {
            const handle = await observations.openViewObservation(input);
            return {
                onInvalidate: handle.onInvalidate.bind(handle),
                isCurrent: handle.isCurrent.bind(handle),
                close: handle.close.bind(handle),
                async readSnapshot(inputTime: { observedAtUtcMs: number; }) {
                    const result = await handle.readSnapshot(inputTime);
                    reads.push({ objectId: input.target.objectId, projectId: input.target.projectId, result });
                    return result;
                },
            };
        },
    };
    const runtime = new NotificationObservationRuntime(server.notificationSettings, observing, acl.checkAccess, {
        quietMs: 5,
        maxWaitMs: 30,
        reconcileMs: 50,
        attemptTimeoutMs: 10_000,
        ...options,
    });
    const offered: PreparedViewChange[] = [];
    runtime.subscribe("mcp", candidate => {
        offered.push(candidate);
    });
    if (captureMobile) {
        runtime.subscribe("mobile", candidate => {
            offered.push(candidate);
        });
    }
    const seed = async (projectId = PROJECT, owner = UID) => {
        acl.grant("projectUsers", projectId, owner);
        const opened = await seedRuntimeProject(server.hocuspocus, projectId, owner);
        connections.push(...opened);
        return { project: opened[0].document as unknown as Y.Doc, source: opened[1].document as unknown as Y.Doc };
    };
    const call = async (name: string, args: unknown, owner = UID) => {
        const token =
            signAccessToken({ uid: owner, scope: "outliner.read outliner.write", clientId: "runtime-test" }).token;
        const response = await request(server.server).post("/mcp").set("Authorization", `Bearer ${token}`)
            .set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", "tools/call").set("MCP-Name", name)
            .set("Accept", "application/json, text/event-stream").send({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name,
                    arguments: args,
                    _meta: {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            });
        const envelope = response.body?.jsonrpc
            ? response.body
            : JSON.parse(response.text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
        expect(envelope.error, JSON.stringify(envelope)).to.equal(undefined);
        expect(envelope.result.isError, JSON.stringify(envelope.result)).not.to.equal(true);
        return envelope.result;
    };
    const update = async (upsert: NotificationRule[], removeRuleIds: string[] = [], owner = UID) => {
        const expectedRevision = server.notificationSettings.get(owner).revision;
        return call("update_notification_settings", { expectedRevision, upsert, removeRuleIds }, owner);
    };
    const watching = async (ruleIds: string[], owner = UID) => {
        try {
            await waitFor(() => ruleIds.every(ruleId =>
                runtime.status(owner).some(
                    status => status.ruleId === ruleId && status.state === "watching",
                )
            ), 15_000);
        } catch {
            throw new Error(
                JSON.stringify({
                    statuses: runtime.status(owner),
                    diagnostics: runtime.diagnostics(),
                    reads: reads.slice(-4),
                }),
            );
        }
    };
    let closed = false;
    return {
        server,
        acl,
        runtime,
        observations,
        offered,
        reads,
        directory,
        seed,
        call,
        update,
        watching,
        connections,
        async evaluated(action: () => void | Promise<unknown>, objectId = "watched") {
            const before = reads.filter(read => read.objectId === objectId).length;
            await action();
            await waitFor(() => reads.filter(read => read.objectId === objectId).length > before, 15_000);
            await new Promise<void>(resolve => setImmediate(resolve));
        },
        async close() {
            if (closed) return;
            closed = true;
            await runtime.close();
            await Promise.all(connections.map(connection => connection.disconnect()));
            await stopTestServer(server);
        },
    };
}
export type RuntimeFixture = Awaited<ReturnType<typeof runtimeFixture>>;

export async function seedRuntimeProject(host: Hocuspocus, projectId: string, uid: string) {
    const project = Project.createInstance("Notification runtime");
    const source = new Y.Doc({ guid: `${projectId}--table--tasks` });
    source.getText("schema").insert(0,
        "CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, status TEXT, starts DATE, hidden TEXT)");
    for (const [id, title, status, starts] of [["a", "A", "todo", "2026-11-21"], ["b", "B", "done", "2026-11-22"]]) {
        const record = new Y.Map<unknown>();
        for (const [key, value] of Object.entries({ id, title, status, starts, hidden: `SECRET-${id}` })) {
            record.set(key, value);
        }
        source.getMap("data").set(id, record);
    }
    const table = new Y.Map<unknown>();
    table.set("name", "Tasks");
    table.set("sqlName", "tasks");
    table.set("doc", source);
    project.ydoc.getMap("yjsTables").set("tasks", table);
    createGridEntry(project.ydoc as never, "watched", {
        name: "Watched tasks",
        query: "SELECT id, title, status, hidden FROM tasks WHERE status = 'todo' ORDER BY id",
        components: { id: { hidden: true }, hidden: { hidden: true } },
    });
    createGridEntry(project.ydoc as never, "aggregate", {
        name: "Count",
        query: "SELECT COUNT(*) AS total FROM tasks",
    });
    createKanbanEntry(project.ydoc as never, "board", {
        name: "Task board",
        query: "SELECT id, title, status, hidden FROM tasks ORDER BY id",
        groupField: "status",
        titleField: "title",
        laneOrder: ["todo", "done"],
        detailFields: [],
    });
    const calendar = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({
        name: "Task calendar",
        query: "SELECT id AS source_id, 'tasks' AS source_kind, title, starts FROM tasks "
            + "WHERE starts >= current_setting('view.range_start')::date AND starts < current_setting('view.range_end')::date",
        roleTitle: "title",
        roleStart: "starts",
        groupAxes: [],
        laneOrder: [],
    })) calendar.set(key, value);
    project.ydoc.getMap("calendars").set("calendar", calendar);
    const parent = await host.openDirectConnection(`projects/${projectId}`, { context: { uid } });
    Y.applyUpdate(parent.document as unknown as Y.Doc, Y.encodeStateAsUpdate(project.ydoc as never));
    const child = await host.openDirectConnection(`projects/${projectId}/tables/tasks`, { context: { uid } });
    Y.applyUpdate(child.document as unknown as Y.Doc, Y.encodeStateAsUpdate(source));
    return [parent, child];
}

export function edit(source: Y.Doc, title: string, rowId = "a", field = "title") {
    source.getMap<Y.Map<unknown>>("data").get(rowId)!.set(field, title);
}
