import { expect } from "chai";
import { validateMobilePayload } from "../../../shared/src/notifications/mobile-payload.js";
import { Project } from "../../src/schema/app-schema.js";
import { calendarRule, edit, kanbanRule, PROJECT, rule, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush, verifyVapid } from "./web-push-crypto.fixture.js";
import { mobileRule, type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("Web Push from production displayed projections", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    afterEach(async () => f?.close());

    it("encrypts only an actual displayed Grid change and preserves Web Push request semantics", async () => {
        f = await webPushFixture();
        const receiver = await f.enroll();
        const { project } = await f.seed();
        f.runtime.start();
        const aggregate = mobileRule({ ...rule("watch-count"), target: { ...rule().target, objectId: "aggregate" } });
        await f.update([mobileRule(), aggregate]);
        await f.watching(["watch-grid", "watch-count"]);
        const write = (rowId: string, column: string, value: string) => f.call("write_relation", {
            projectId: PROJECT,
            relation: "tasks",
            write: { op: "UPDATE", rowId, column, value },
        });
        await f.evaluated(() => {
            const page = Project.fromDoc(project).addPage("Extra placements", UID);
            for (let index = 0; index < 2; index++) {
                const item = page.items.addNode(UID);
                item.componentType = "yjstable";
                item.yjsGridId = "watched";
            }
        });
        await f.evaluated(() => write("a", "hidden", "SECRET-HIDDEN-EDIT"));
        await f.evaluated(() => write("b", "title", "Excluded row"));
        expect(f.captured.requests).to.have.length(0);
        await write("a", "title", "Displayed update");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.captured.requests).to.have.length(1);
        const captured = f.captured.requests[0];
        const { payload, plaintext } = decryptPush(captured, receiver);
        expect(plaintext.byteLength).to.be.at.most(3000);
        expect(validateMobilePayload(payload)).to.deep.equal(payload);
        expect(payload.target).to.deep.equal(rule().target);
        expect(payload.ruleId).to.equal("watch-grid");
        expect(payload.enrollmentGeneration).to.equal(receiver.enrollmentGeneration);
        expect(payload.body).to.contain("Displayed update");
        expect(Number.isFinite(Date.parse(payload.observedAt))).to.equal(true);
        const json = plaintext.toString("utf8");
        for (const forbidden of ["SECRET", "SELECT", UID, receiver.endpoint, receiver.auth.toString("base64url")]) {
            expect(json).not.to.contain(forbidden);
        }
        expect(payload).to.have.all.keys("schemaVersion", "eventId", "ruleId", "target", "observedAt", "title", "body",
            "href", "enrollmentGeneration");
        expect(captured.options.path).to.equal(`/send/${receiver.deviceId}?opaque=preserved`);
        expect(captured.options.headers).to.include({
            ttl: "60",
            urgency: "normal",
            "content-encoding": "aes128gcm",
            host: "push.example.test",
            "content-length": String(captured.body.byteLength),
        });
        const headers = captured.options.headers as Record<string, string>;
        expect(headers.topic).to.match(/^[A-Za-z0-9_-]{1,32}$/u);
        verifyVapid(captured, f.config);
        expect(f.settlements).to.deep.equal([{ initiated: true, outcome: "accepted" }]);
        await f.evaluated(() => write("a", "hidden", "SECRET-AFTER-SEND"));
        expect(f.captured.requests).to.have.length(1);
    });

    it("delivers real Kanban grouping and Calendar membership in their saved contexts", async () => {
        f = await webPushFixture();
        const receiver = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule(calendarRule()), mobileRule(kanbanRule())]);
        await f.watching(["watch-calendar", "watch-kanban"]);
        edit(source, "done", "a", "status");
        await waitFor(() => f.settlements.length === 1, 20_000);
        const board = decryptPush(f.captured.requests[0], receiver).payload;
        expect(board.target.kind).to.equal("kanban");
        expect(board.body).not.to.contain("SECRET");
        const boardHref = new URL(board.href, "https://outliner.example.test");
        expect(Object.fromEntries(boardHref.searchParams)).to.deep.equal({
            version: "1",
            surface: "board",
            locale: "en-US",
            timeZone: "UTC",
        });
        edit(source, "2026-11-23", "a", "starts");
        await waitFor(() => f.settlements.length === 2, 20_000);
        const calendar = decryptPush(f.captured.requests[1], receiver).payload;
        expect(calendar.target.kind).to.equal("calendar");
        expect(calendar.body).not.to.contain("SECRET");
        const href = new URL(calendar.href, "https://outliner.example.test");
        expect(JSON.parse(href.searchParams.get("context")!)).to.deep.equal(calendarRule().context);
        expect(validateMobilePayload(calendar)).to.deep.equal(calendar);
    });
});
