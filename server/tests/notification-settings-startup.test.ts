import { expect } from "chai";
import https from "node:https";
import tls from "node:tls";
import sinon from "sinon";
import request from "supertest";
import * as Y from "yjs";
import { computeViewRange } from "../../shared/src/services/calendarGridRange.js";
import { signAccessToken } from "../src/oauth/tokens.js";
import { Project } from "../src/schema/app-schema.js";
import { AclStore, seedProject, startTestServer, stopTestServer, tempDir } from "./server-create-table-fixture.js";

describe("notification settings production startup", () => {
    const rpc = (name: string, args: unknown) => ({
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
    const bodyOf = (response: request.Response) =>
        response.body?.jsonrpc
            ? response.body
            : JSON.parse(response.text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    const call = async (
        server: Awaited<ReturnType<typeof startTestServer>>,
        token: string,
        name: string,
        args: unknown,
    ) => bodyOf(await request(server.server).post("/mcp").set("Authorization", `Bearer ${token}`)
        .set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", "tools/call").set("MCP-Name", name)
        .set("Accept", "application/json, text/event-stream").send(rpc(name, args))).result;

    it("persists authorized target and Calendar settings across a mounted restart", async () => {
        let permissionCalls = 0;
        const priorNotification = (globalThis as Record<string, unknown>).Notification;
        (globalThis as Record<string, unknown>).Notification = { requestPermission: () => permissionCalls++ };
        const directory = tempDir();
        const acl = new AclStore();
        acl.grant("projectUsers", "project-live", "owner");
        let server = await startTestServer(directory, acl);
        await seedProject(server.hocuspocus, "project-live");
        const connection = await server.hocuspocus.openDirectConnection("projects/project-live", {});
        const project = Project.fromDoc(connection.document as unknown as Y.Doc);
        const calendar = new Y.Map<unknown>();
        calendar.set("name", "Live calendar");
        project.calendars.set("calendar-live", calendar);
        await connection.disconnect();
        const token = signAccessToken({ uid: "owner", scope: "outliner.read outliner.write", clientId: "test" }).token;
        const events: unknown[] = [];
        server.notificationSettings.onCommittedChange(event => events.push(event));
        const grid = {
            ruleId: "grid",
            target: { projectId: "project-live", kind: "grid", objectId: "grid-existing" },
            enabled: true,
            channels: { mcp: true, mobile: false },
            context: { version: 1, locale: "en-US", timeZone: "Etc/UTC", surface: "table" },
        };
        // This Monday-start week crosses New York's 2026 spring DST transition.
        const anchor = Date.parse("2026-03-06T16:00:00Z");
        const range = computeViewRange(anchor, "week", 1, "America/New_York");
        expect(range.end - range.start).to.equal(167 * 60 * 60 * 1_000);
        const calendarRule = {
            ruleId: "calendar",
            target: { projectId: "project-live", kind: "calendar", objectId: "calendar-live" },
            enabled: true,
            channels: { mcp: false, mobile: true },
            context: {
                version: 1,
                locale: "en-US",
                timeZone: "America/New_York",
                weekStart: 1,
                viewType: "week",
                anchorUtcMs: anchor,
                rangeStartUtcMs: range.start,
                rangeEndUtcMs: range.end,
                monthLaneFilter: null,
                collapsedEntryKeys: [],
            },
        };
        const wrongKind = {
            ...calendarRule,
            ruleId: "wrong",
            target: { ...calendarRule.target, objectId: "grid-existing" },
        };
        const denied = await call(server, token, "update_notification_settings", {
            expectedRevision: 0,
            upsert: [grid, wrongKind],
            removeRuleIds: [],
        });
        expect(denied.isError).to.equal(true);
        expect(server.notificationSettings.get("owner")).to.deep.equal({ revision: 0, rules: [] });
        expect(events).to.deep.equal([]);
        const badRange = {
            ...calendarRule,
            // A fixed seven-day UTC interval is an hour too long across spring DST.
            context: { ...calendarRule.context, rangeEndUtcMs: range.start + 7 * 24 * 60 * 60 * 1_000 },
        };
        expect(
            (await call(server, token, "update_notification_settings", {
                expectedRevision: 0,
                upsert: [grid, badRange],
                removeRuleIds: [],
            })).isError,
        ).to.equal(true);
        // These are the concrete network boundaries used by the available MCP
        // callback and web-push transports. Settings changes must not reach any
        // of them, regardless of which channel flags are enabled.
        const sandbox = sinon.createSandbox();
        const tlsSpy = sandbox.spy(tls, "connect");
        const httpsSpy = sandbox.spy(https, "request");
        let applied: Awaited<ReturnType<typeof call>>;
        let transportCalls: { tls: number; https: number; };
        try {
            applied = await call(server, token, "update_notification_settings", {
                expectedRevision: 0,
                upsert: [grid, calendarRule],
                removeRuleIds: [],
            });
            transportCalls = { tls: tlsSpy.callCount, https: httpsSpy.callCount };
        } finally {
            sandbox.restore();
        }
        expect(applied.structuredContent.settings.rules.map((rule: { channels: unknown; }) => rule.channels))
            .to.deep.equal([{ mcp: false, mobile: true }, { mcp: true, mobile: false }]);
        expect(events).to.deep.equal([{ uid: "owner", revision: 1 }]);
        expect(transportCalls!).to.deep.equal({ tls: 0, https: 0 });
        const notificationTables = server.persistence!.db!.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notification_%' ORDER BY name",
        ).all().map((row: unknown) => (row as { name: string; }).name);
        expect(notificationTables).to.deep.equal(["notification_rules", "notification_settings_heads"]);
        await stopTestServer(server);
        server = await startTestServer(directory, acl);
        const reopened = await call(server, token, "get_notification_settings", {});
        expect(reopened.structuredContent).to.deep.equal(applied.structuredContent.settings);
        expect(permissionCalls).to.equal(0);
        if (priorNotification === undefined) delete (globalThis as Record<string, unknown>).Notification;
        else (globalThis as Record<string, unknown>).Notification = priorNotification;
        await stopTestServer(server);
    });
});
