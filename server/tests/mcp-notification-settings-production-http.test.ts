import Database from "better-sqlite3";
import { expect } from "chai";
import express from "express";
import request from "supertest";
import * as Y from "yjs";
import { computeViewRange } from "../../shared/src/services/calendarGridRange.js";
import { getKanbanRegistry } from "../../shared/src/services/kanbanDefinition.js";
import { KanbanObservationService } from "../src/mcp/kanban-observations.js";
import { OutlinerKanbanReadService } from "../src/mcp/kanban-read-service.js";
import { createMcpRouter } from "../src/mcp/mcp-api.js";
import { NotificationSettingsService } from "../src/notifications/settings-service.js";
import { NotificationSettingsStore } from "../src/notifications/settings-store.js";
import { createGridFixture } from "./mcp-create-grid-fixture.js";

describe("notification settings production readers through MCP", () => {
    const bodyOf = (response: request.Response) => {
        if (response.body?.jsonrpc) return response.body;
        return JSON.parse(response.text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    };
    const call = async (app: express.Express, args: unknown) =>
        bodyOf(await request(app).post("/mcp")
            .set("Authorization", "Bearer write").set("MCP-Protocol-Version", "2026-07-28")
            .set("MCP-Method", "tools/call").set("MCP-Name", "update_notification_settings")
            .set("Accept", "application/json, text/event-stream").send({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "update_notification_settings",
                    arguments: args,
                    _meta: {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            })).result;
    const context = (surface: "table" | "board", timeZone = "UTC") => ({
        version: 1 as const,
        locale: "en-US",
        timeZone,
        surface,
    });

    it("atomically refuses wrong-kind live targets and incoherent DST Calendar ranges", async () => {
        let permissionCalls = 0;
        const priorNotification = (globalThis as Record<string, unknown>).Notification;
        (globalThis as Record<string, unknown>).Notification = {
            requestPermission: () => {
                permissionCalls++;
                throw new Error("permission side effect");
            },
        };
        const fixture = createGridFixture();
        const calendar = new Y.Map<unknown>();
        calendar.set("name", "Planning");
        fixture.project.calendars.set("calendar-existing", calendar);
        const kanban = new Y.Map<unknown>();
        kanban.set("name", "Board");
        getKanbanRegistry(fixture.project.ydoc as never).set("kanban-existing", kanban as never);
        const kanbanReads = new OutlinerKanbanReadService(fixture.hocuspocus, async () => true,
            new KanbanObservationService(fixture.hocuspocus));
        const db = new Database(":memory:");
        const service = new NotificationSettingsService(new NotificationSettingsStore(() => db), {
            assertTarget: async (uid, target) => {
                if (target.kind === "grid") await fixture.reads.getGrid(uid, target.projectId, target.objectId);
                else if (target.kind === "calendar") {
                    await fixture.reads.getCalendar(uid, target.projectId, target.objectId);
                } else await kanbanReads.assertTargetExists(uid, target.projectId, target.objectId);
            },
            listTargets: (uid, projectId) => fixture.reads.listNotificationTargets(uid, projectId),
        });
        const events: unknown[] = [];
        service.onCommittedChange(event => events.push(event));
        const app = express();
        app.use(express.json());
        app.use(
            createMcpRouter(fixture.reads, () => ({ uid: "owner", scope: "outliner.read outliner.write" }),
                "http://localhost", undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                undefined, service),
        );
        const gridRule = {
            ruleId: "grid",
            target: { projectId: "project-1", kind: "grid", objectId: "grid-existing" },
            enabled: true,
            channels: { mcp: true, mobile: false },
            context: context("table", "Etc/UTC"),
        };
        const kanbanRule = {
            ...gridRule,
            ruleId: "kanban",
            target: { ...gridRule.target, kind: "kanban", objectId: "kanban-existing" },
            context: context("board", "Etc/UTC"),
        };
        const anchor = Date.parse("2026-03-09T16:00:00Z");
        const expected = computeViewRange(anchor, "week", 1, "America/New_York");
        const calendarContext = {
            version: 1,
            locale: "en-US",
            timeZone: "America/New_York",
            weekStart: 1,
            viewType: "week",
            anchorUtcMs: anchor,
            rangeStartUtcMs: expected.start,
            rangeEndUtcMs: expected.end,
            monthLaneFilter: null,
            collapsedEntryKeys: [],
        };
        const wrongKind = {
            ...gridRule,
            ruleId: "wrong",
            target: { ...gridRule.target, kind: "calendar" },
            context: calendarContext,
        };
        const denied = await call(app, { expectedRevision: 0, upsert: [gridRule, wrongKind], removeRuleIds: [] });
        expect(denied.isError).to.equal(true);
        expect(service.get("owner")).to.deep.equal({ revision: 0, rules: [] });
        expect(events).to.deep.equal([]);

        const badCalendar = {
            ruleId: "calendar",
            target: { projectId: "project-1", kind: "calendar", objectId: "calendar-existing" },
            enabled: true,
            channels: { mcp: false, mobile: true },
            context: {
                ...calendarContext,
                rangeStartUtcMs: expected.start + 3_600_000,
            },
        };
        const incoherent = await call(app, { expectedRevision: 0, upsert: [gridRule, badCalendar], removeRuleIds: [] });
        expect(incoherent.isError).to.equal(true);
        expect(service.get("owner")).to.deep.equal({ revision: 0, rules: [] });

        const accepted = await call(app, { expectedRevision: 0, upsert: [gridRule, kanbanRule], removeRuleIds: [] });
        expect(
            accepted.structuredContent.settings.rules.map((saved: { context: { timeZone: string; }; }) =>
                saved.context.timeZone
            ),
        ).to.deep.equal(["UTC", "UTC"]);
        const noOp = await call(app, { expectedRevision: 1, upsert: [gridRule, kanbanRule], removeRuleIds: [] });
        expect(noOp.structuredContent).to.include({ applied: false, priorRevision: 1 });
        const mobileOnlyKanban = { ...kanbanRule, channels: { mcp: false, mobile: true } };
        const channels = await call(app, { expectedRevision: 1, upsert: [mobileOnlyKanban], removeRuleIds: [] });
        expect(channels.structuredContent.settings.rules.map((saved: { channels: unknown; }) => saved.channels))
            .to.deep.equal([{ mcp: true, mobile: false }, { mcp: false, mobile: true }]);
        expect(events).to.deep.equal([{ uid: "owner", revision: 1 }, { uid: "owner", revision: 2 }]);
        expect(permissionCalls).to.equal(0);
        if (priorNotification === undefined) delete (globalThis as Record<string, unknown>).Notification;
        else (globalThis as Record<string, unknown>).Notification = priorNotification;
        db.close();
    });
});
