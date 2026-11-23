import { expect } from "chai";
import request from "supertest";
import * as Y from "yjs";
import { signAccessToken } from "../src/oauth/tokens.js";
import { AclStore, seedProject, startTestServer, stopTestServer, tempDir } from "./server-create-table-fixture.js";

const context = { version: 1, locale: "en-US", timeZone: "UTC", surface: "table" } as const;
const rule = (ruleId: string, projectId: string, objectId = "grid-existing") => ({
    ruleId,
    target: { projectId, kind: "grid", objectId },
    enabled: true,
    channels: { mcp: true, mobile: false },
    context,
});

describe("notification settings REQ-011 production startup", () => {
    const start = async (projects: string[]) => {
        const acl = new AclStore();
        for (const projectId of projects) acl.grant("projectUsers", projectId, "owner");
        const server = await startTestServer(tempDir(), acl);
        for (const projectId of projects) await seedProject(server.hocuspocus, projectId);
        const token = signAccessToken({ uid: "owner", scope: "outliner.read outliner.write", clientId: "test" }).token;
        const call = async (name: string, args: unknown) => {
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
            const body = response.body?.jsonrpc
                ? response.body
                : JSON.parse(response.text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
            return body.result;
        };
        return { acl, server, call };
    };

    it("keeps stale identities private and removable after target deletion and access revocation", async () => {
        const { acl, server, call } = await start(["kept-project", "revoked-project"]);
        try {
            const kept = rule("kept", "kept-project");
            const stale = rule("stale", "revoked-project");
            const applied = await call("update_notification_settings", {
                expectedRevision: 0,
                upsert: [kept, stale],
                removeRuleIds: [],
            });
            expect(applied.structuredContent.settings.revision).to.equal(1);

            const connection = await server.hocuspocus.openDirectConnection("projects/revoked-project", {});
            (connection.document as unknown as Y.Doc).getMap("yjsGrids").delete("grid-existing");
            await connection.disconnect();
            acl.revokeAll("revoked-project");

            const read = await call("get_notification_settings", {});
            expect(read.structuredContent.rules).to.deep.equal([kept, stale]);
            for (const saved of read.structuredContent.rules) {
                expect(saved).to.have.all.keys("ruleId", "target", "enabled", "channels", "context");
                expect(saved.target).to.have.all.keys("projectId", "kind", "objectId");
            }
            const removed = await call("update_notification_settings", {
                expectedRevision: 1,
                upsert: [],
                removeRuleIds: ["stale"],
            });
            expect(removed.structuredContent.settings).to.deep.equal({ revision: 2, rules: [kept] });
            expect(server.notificationSettings.store.get("owner")).to.deep.equal({ revision: 2, rules: [kept] });
        } finally {
            await stopTestServer(server);
        }
    });

    it("refuses rule-count and serialized-size limits without a commit", async () => {
        const longProjectId = `project-${"p".repeat(180)}`;
        const longObjectId = `grid-${"g".repeat(180)}`;
        const { server, call } = await start([longProjectId]);
        try {
            const connection = await server.hocuspocus.openDirectConnection(`projects/${longProjectId}`, {});
            const grid = new Y.Map<unknown>();
            grid.set("name", "Long target");
            (connection.document as unknown as Y.Doc).getMap("yjsGrids").set(longObjectId, grid);
            await connection.disconnect();
            const events: unknown[] = [];
            server.notificationSettings.onCommittedChange(event => events.push(event));
            const rules = Array.from({ length: 129 },
                (_, index) => rule(`rule-${String(index).padStart(3, "0")}`, longProjectId, longObjectId));
            const tooMany = await call("update_notification_settings", {
                expectedRevision: 0,
                upsert: rules,
                removeRuleIds: [],
            });
            expect(tooMany.isError).to.equal(true);
            expect(JSON.parse(tooMany.content[0].text)).to.include({
                code: "invalid_argument",
                error: "settings limits exceeded",
            });

            const oversized = rules.slice(0, 128).map((entry, index) => ({
                ...entry,
                ruleId: `${String(index).padStart(3, "0")}-${"r".repeat(196)}`,
            }));
            expect(Buffer.byteLength(JSON.stringify({ revision: 1, rules: oversized }))).to.be.greaterThan(65_536);
            const tooLarge = await call("update_notification_settings", {
                expectedRevision: 0,
                upsert: oversized,
                removeRuleIds: [],
            });
            expect(tooLarge.isError).to.equal(true);
            expect(JSON.parse(tooLarge.content[0].text)).to.include({
                code: "invalid_argument",
                error: "settings limits exceeded",
            });
            expect(events).to.deep.equal([]);
            expect(server.notificationSettings.store.get("owner")).to.deep.equal({ revision: 0, rules: [] });
            expect(
                server.persistence!.db!.prepare("SELECT revision FROM notification_settings_heads WHERE uid=?")
                    .get("owner"),
            ).to.equal(undefined);
        } finally {
            await stopTestServer(server);
        }
    });

    it("atomically rejects malformed removal IDs and rule IDs equal to target IDs", async () => {
        const { server, call } = await start(["validation-project"]);
        try {
            const events: unknown[] = [];
            server.notificationSettings.onCommittedChange(event => events.push(event));
            const valid = rule("valid-rule", "validation-project");
            const invalidChanges = [
                { upsert: [valid], removeRuleIds: [""] },
                { upsert: [valid], removeRuleIds: ["x".repeat(201)] },
                {
                    upsert: [valid, rule("grid-existing", "validation-project")],
                    removeRuleIds: [],
                },
            ];
            for (const change of invalidChanges) {
                const refused = await call("update_notification_settings", { expectedRevision: 0, ...change });
                expect(refused.isError).to.equal(true);
                expect(JSON.parse(refused.content[0].text).code).to.equal("invalid_argument");
                expect(server.notificationSettings.store.get("owner")).to.deep.equal({ revision: 0, rules: [] });
                expect(events).to.deep.equal([]);
            }
            expect(
                server.persistence!.db!.prepare("SELECT revision FROM notification_settings_heads WHERE uid=?")
                    .get("owner"),
            ).to.equal(undefined);
        } finally {
            await stopTestServer(server);
        }
    });
});
