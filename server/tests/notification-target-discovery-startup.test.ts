import { expect } from "chai";
import request from "supertest";
import * as Y from "yjs";
import { signAccessToken } from "../src/oauth/tokens.js";
import { Project } from "../src/schema/app-schema.js";
import { AclStore, seedProject, startTestServer, stopTestServer, tempDir } from "./server-create-table-fixture.js";

describe("notification target discovery production startup", () => {
    it("pages only supported live targets in stable order and enforces project access", async () => {
        const acl = new AclStore();
        acl.grant("projectUsers", "catalog", "owner");
        const server = await startTestServer(tempDir(), acl);
        try {
            await seedProject(server.hocuspocus, "catalog");
            await seedProject(server.hocuspocus, "denied");
            const connection = await server.hocuspocus.openDirectConnection("projects/catalog", {});
            const doc = connection.document as unknown as Y.Doc;
            const project = Project.fromDoc(doc);
            doc.getMap<Y.Map<unknown>>("yjsGrids").get("grid-existing")!.set("name", "Grid");
            const calendar = new Y.Map<unknown>();
            calendar.set("name", "Calendar");
            project.calendars.set("calendar-existing", calendar);
            const kanban = new Y.Map<unknown>();
            kanban.set("name", "Kanban");
            doc.getMap<Y.Map<unknown>>("yjsKanbans").set("kanban-existing", kanban);
            doc.getMap("yjsDiagrams").set("diagram-existing", new Y.Map());
            await connection.disconnect();

            const token = signAccessToken({
                uid: "owner",
                scope: "outliner.read outliner.write",
                clientId: "test",
            }).token;
            const call = async (args: unknown) => {
                const response = await request(server.server).post("/mcp").set("Authorization", `Bearer ${token}`)
                    .set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", "tools/call")
                    .set("MCP-Name", "list_notification_targets").set("Accept", "application/json, text/event-stream")
                    .send({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "tools/call",
                        params: {
                            name: "list_notification_targets",
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

            const first = await call({ projectId: "catalog", limit: 2 });
            expect(first.structuredContent.targets).to.deep.equal([
                {
                    objectId: "calendar-existing",
                    kind: "calendar",
                    name: "Calendar",
                    contextShape: "v1/calendar-range",
                },
                { objectId: "grid-existing", kind: "grid", name: "Grid", contextShape: "v1/table" },
            ]);
            expect(first.structuredContent.cursor).to.be.a("string");
            const second = await call({ projectId: "catalog", limit: 2, cursor: first.structuredContent.cursor });
            expect(second.structuredContent).to.deep.equal({
                projectId: "catalog",
                targets: [{ objectId: "kanban-existing", kind: "kanban", name: "Kanban", contextShape: "v1/board" }],
            });
            expect([...first.structuredContent.targets, ...second.structuredContent.targets].map(target => target.kind))
                .to.deep.equal(["calendar", "grid", "kanban"]);
            for (const args of [{ projectId: "catalog", limit: 0 }, { projectId: "catalog", limit: 101 }]) {
                const invalid = await call(args);
                expect(invalid.isError).to.equal(true);
                expect(invalid.content[0].text).to.include("Invalid arguments");
            }
            const invalidCursor = await call({ projectId: "catalog", limit: 2, cursor: "not-a-cursor" });
            expect(invalidCursor.isError).to.equal(true);
            expect(JSON.parse(invalidCursor.content[0].text).code).to.equal("invalid_argument");
            const denied = await call({ projectId: "denied", limit: 100 });
            expect(denied.isError).to.equal(true);
            expect(JSON.parse(denied.content[0].text).code).to.equal("forbidden");
        } finally {
            await stopTestServer(server);
        }
    });
});
