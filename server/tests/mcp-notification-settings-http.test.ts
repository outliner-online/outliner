import Database from "better-sqlite3";
import { expect } from "chai";
import express from "express";
import request from "supertest";
import { createMcpRouter } from "../src/mcp/mcp-api.js";
import type { OutlinerReadService } from "../src/mcp/outliner-read-service.js";
import { NotificationSettingsService } from "../src/notifications/settings-service.js";
import { NotificationSettingsStore } from "../src/notifications/settings-store.js";

describe("notification settings mounted MCP tools", () => {
    const rpc = (name: string, args: unknown, id = 1) => ({
        jsonrpc: "2.0",
        id,
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
    const bodyOf = (response: request.Response) => {
        if (response.body?.jsonrpc) return response.body;
        const data = response.text.split("\n").find(line => line.startsWith("data: "));
        return JSON.parse(data?.slice(6) ?? "{}");
    };
    const post = (app: express.Express, token: string, name: string, args: unknown) =>
        request(app).post("/mcp").set("Authorization", `Bearer ${token}`)
            .set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", "tools/call")
            .set("MCP-Name", name).set("Accept", "application/json, text/event-stream").send(rpc(name, args));
    const reads = {} as OutlinerReadService;
    const rule = {
        ruleId: "rule",
        target: { projectId: "project", kind: "grid" as const, objectId: "grid" },
        enabled: true,
        channels: { mcp: true, mobile: false },
        context: { version: 1 as const, locale: "en-US", timeZone: "UTC", surface: "table" as const },
    };

    it("preserves scope, ownership, revision conflict, and unavailable outcomes", async () => {
        const db = new Database(":memory:");
        const service = new NotificationSettingsService(new NotificationSettingsStore(() => db), {
            assertTarget: async () => {},
            listTargets: async () => [],
        });
        const app = express();
        app.use(express.json());
        app.use(createMcpRouter(reads, token => ({
            uid: token.startsWith("other") ? "other-owner" : "owner",
            scope: token.endsWith("-write") ? "outliner.read outliner.write" : "outliner.read",
        }), "http://localhost", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            service));

        const refusedBody = bodyOf(await post(app, "owner-read", "update_notification_settings", {}));
        if (!refusedBody.result) throw new Error(JSON.stringify(refusedBody));
        const refused = refusedBody.result;
        expect(refused.isError).to.equal(true);
        expect(JSON.parse(refused.content[0].text).code).to.equal("forbidden");

        const applied = bodyOf(
            await post(app, "owner-write", "update_notification_settings", {
                expectedRevision: 0,
                upsert: [rule],
                removeRuleIds: [],
            }),
        ).result;
        expect(applied.structuredContent.settings.revision).to.equal(1);
        const other = bodyOf(await post(app, "other-read", "get_notification_settings", {})).result;
        expect(other.structuredContent).to.deep.equal({ revision: 0, rules: [] });

        const stale = bodyOf(
            await post(app, "owner-write", "update_notification_settings", {
                expectedRevision: 0,
                upsert: [],
                removeRuleIds: [],
            }),
        ).result;
        expect(JSON.parse(stale.content[0].text).code).to.equal("stale_revision");
        expect(service.get("owner").revision).to.equal(1);

        db.close();
        const unavailable = bodyOf(await post(app, "owner-read", "get_notification_settings", {})).result;
        expect(JSON.parse(unavailable.content[0].text).code).to.equal("unavailable");
    });
});
