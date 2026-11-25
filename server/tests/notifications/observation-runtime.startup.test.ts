import { expect } from "chai";
import request from "supertest";
import type { PreparedViewChange } from "../../src/notifications/prepared-view-change.js";
import { signAccessToken } from "../../src/oauth/tokens.js";
import { AclStore, startTestServer, stopTestServer, tempDir, waitFor } from "../server-create-table-fixture.js";
import { PROJECT, rule, seedRuntimeProject, UID } from "./observation-runtime.fixture.js";

describe("notification observation server startup and private MCP status", function() {
    this.timeout(30_000);

    it("starts from durable MCP rules and exposes only the authenticated owner's bounded observation status", async () => {
        const acl = new AclStore();
        acl.grant("projectUsers", PROJECT, UID);
        const server = await startTestServer(tempDir(), acl);
        const connections = await seedRuntimeProject(server.hocuspocus, PROJECT, UID);
        const offered: PreparedViewChange[] = [];
        server.notificationRuntime.subscribe("mcp", candidate => {
            offered.push(candidate);
        });
        async function call(name: string, args: unknown, owner = UID, scope = "outliner.read outliner.write") {
            const token = signAccessToken({ uid: owner, scope, clientId: "observation-startup" }).token;
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
        }
        try {
            const applied = await call("update_notification_settings", {
                expectedRevision: 0,
                upsert: [rule()],
                removeRuleIds: [],
            });
            expect(applied.isError).not.to.equal(true);
            await waitFor(() => server.notificationRuntime.status(UID).some(status => status.state === "watching"),
                15_000);
            expect(offered).to.have.length(0);
            const status = await call("get_notification_status", {}, UID, "outliner.read");
            expect(status.isError).not.to.equal(true);
            expect(status.structuredContent).to.deep.equal([
                { ruleId: "watch-grid", channel: "mcp", state: "watching" },
                { ruleId: "watch-grid", channel: "mobile", state: "disabled" },
            ]);
            const privateStatus = await call("get_notification_status", {}, "another-owner", "outliner.read");
            expect(privateStatus.structuredContent).to.deep.equal([]);
            const spoofed = await call("get_notification_status", { uid: UID }, "another-owner", "outliner.read");
            expect(spoofed.isError).to.equal(true);
            const written = await call("write_relation", {
                projectId: PROJECT,
                relation: "tasks",
                write: { op: "UPDATE", rowId: "a", column: "title", value: "Changed without a viewer" },
            });
            expect(written.isError).not.to.equal(true);
            await waitFor(() => offered.length === 1, 15_000);
            expect(offered[0].target).to.deep.equal(rule().target);
            expect(JSON.stringify(offered[0].summary)).to.contain("Changed without a viewer");
            const current = await offered[0].revalidate();
            expect(current.status).to.equal("current");
            if (current.status === "current") expect(current.candidate.isCurrent()).to.equal(true);
            offered[0].settleAttempt({ initiated: false, outcome: "no_destination" });
        } finally {
            await server.notificationRuntime.close();
            await Promise.all(connections.map(connection => connection.disconnect()));
            await stopTestServer(server);
        }
        expect(server.notificationRuntime.diagnostics()).to.include({
            admissions: 0,
            candidates: 0,
            handles: 0,
            timers: 0,
        });
    });
});
