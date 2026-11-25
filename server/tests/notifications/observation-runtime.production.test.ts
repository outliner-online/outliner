import { expect } from "chai";
import * as Y from "yjs";
import { JobScheduler } from "../../src/scheduler/Scheduler.js";
import { Project } from "../../src/schema/app-schema.js";
import {
    calendarRule,
    edit,
    kanbanRule,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./observation-runtime.fixture.js";

describe("notification runtime over production live views", function() {
    this.timeout(60_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("baselines silently and ignores hidden, filtered and unchanged aggregate writes through MCP", async () => {
        f = await runtimeFixture();
        const { project } = await f.seed();
        f.runtime.start();
        const aggregate = { ...rule("watch-count"), target: { ...rule().target, objectId: "aggregate" } };
        await f.update([rule(), aggregate]);
        await f.watching(["watch-grid", "watch-count"]);
        expect(f.offered).to.have.length(0);
        await f.evaluated(() => {
            const page = Project.fromDoc(project).addPage("Two placements", UID);
            for (let index = 0; index < 2; index++) {
                const item = page.items.addNode(UID);
                item.componentType = "yjstable";
                item.yjsGridId = "watched";
            }
        });
        expect(f.offered).to.have.length(0);
        const write = (rowId: string, column: string, value: string) => f.call("write_relation", {
            projectId: PROJECT,
            relation: "tasks",
            write: { op: "UPDATE", rowId, column, value },
        });
        await f.evaluated(() => write("a", "hidden", "SECRET-CHANGED"));
        expect(f.offered).to.have.length(0);
        await f.evaluated(() => write("b", "title", "Excluded row"));
        expect(f.offered).to.have.length(0);
        await write("a", "title", "Visible change");
        await waitFor(() => f.offered.length === 1, 15_000);
        const event = f.offered[0];
        expect(event.target).to.deep.equal(rule().target);
        expect(event.ruleId).to.equal("watch-grid");
        expect(event.channel).to.equal("mcp");
        expect(event.settingsRevision).to.equal(1);
        expect(event.effectiveContext).to.deep.equal(rule().context);
        expect(event.eventId).to.be.a("string").and.not.equal("");
        expect(event.sourceVersionToken).to.be.a("string").and.not.equal("");
        expect(Number.isFinite(Date.parse(event.observedAt))).to.equal(true);
        expect(event.deepLink).to.contain("watched");
        expect(JSON.stringify(event.summary)).to.contain("Visible change").and.not.contain("SECRET");
        const current = await event.revalidate();
        expect(current.status).to.equal("current");
        if (current.status !== "current") throw new Error("Expected a current candidate");
        expect(current.candidate.eventId).to.equal(event.eventId);
        expect(current.candidate.isCurrent()).to.equal(true);
        event.settleAttempt({ initiated: false, outcome: "no_destination" });
        await f.evaluated(() => write("a", "title", "Visible change"));
        expect(f.offered).to.have.length(1);
        await f.call("write_relation", {
            projectId: PROJECT,
            relation: "tasks",
            write: {
                op: "INSERT",
                values: {
                    id: "c",
                    title: "Excluded new row",
                    status: "done",
                    starts: "2026-11-22",
                    hidden: "SECRET-new",
                },
            },
        });
        await waitFor(() => f.offered.length === 2, 15_000);
        expect(f.offered[1].ruleId).to.equal("watch-count");
        expect(JSON.stringify(f.offered[1].summary)).to.contain("total: 3").and.not.contain("SECRET");
    });

    it("detects Calendar membership and Kanban grouping with complete displayed projections", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([calendarRule(), kanbanRule()]);
        await f.watching(["watch-calendar", "watch-kanban"]);
        expect(f.offered).to.have.length(0);
        edit(source, "done", "a", "status");
        await waitFor(() => f.offered.some(event => event.target.kind === "kanban"), 15_000);
        expect(f.offered.filter(event => event.target.kind === "calendar")).to.have.length(0);
        const board = f.offered.find(event => event.target.kind === "kanban")!;
        expect(JSON.stringify(board.summary)).not.to.contain("SECRET");
        board.settleAttempt({ initiated: false, outcome: "no_destination" });
        edit(source, "2026-11-23", "a", "starts");
        await waitFor(() => f.offered.some(event => event.target.kind === "calendar"), 15_000);
        const calendar = f.offered.find(event => event.target.kind === "calendar")!;
        expect(calendar.effectiveContext).to.deep.equal(calendarRule().context);
        expect(calendar.deepLink).to.contain("context=");
        expect(JSON.stringify(calendar.summary)).not.to.contain("SECRET");
    });

    it("keeps two projects observable through MCP and the Scheduler with no viewer", async () => {
        f = await runtimeFixture();
        await f.seed();
        const second = "notification-second";
        const { project } = await f.seed(second);
        const schedule = new Y.Map<unknown>();
        for (const [key, value] of Object.entries({
            name: "Update watched tasks",
            targetTableId: "tasks",
            timezone: "UTC",
            sql: "INSERT INTO tasks (id, title, status, starts, hidden) VALUES "
                + "('scheduler-row', 'Scheduled title', 'todo', DATE '2026-11-21', 'SECRET-scheduler') RETURNING *",
        })) schedule.set(key, value);
        project.getMap("schedules").set("notification-writer", schedule);
        f.runtime.start();
        await f.update([rule(), rule("watch-second", second)]);
        await f.watching(["watch-grid", "watch-second"]);
        await f.call("write_relation", {
            projectId: PROJECT,
            relation: "tasks",
            write: { op: "UPDATE", rowId: "a", column: "title", value: "MCP title" },
        });
        const scheduler = new JobScheduler(f.server.hocuspocus);
        scheduler.setDb(f.server.persistence!.db!);
        scheduler.start(3_600_000, false);
        try {
            const result = await scheduler.runRuleNow(`projects/${second}`, "notification-writer");
            expect(result.success).to.equal(true);
            await waitFor(() => f.offered.length === 2, 20_000);
            expect(f.offered.map(event => event.target.projectId).sort()).to.deep.equal([PROJECT, second].sort());
            expect(JSON.stringify(f.offered.map(event => event.summary))).to.contain("MCP title").and.contain(
                "Scheduled title",
            );
            expect(f.runtime.status("different-owner")).to.deep.equal([]);
            expect(f.runtime.status(UID).length).to.be.greaterThan(0);
        } finally {
            await scheduler.stop();
        }
    });
});
