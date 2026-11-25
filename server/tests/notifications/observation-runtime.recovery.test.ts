import { expect } from "chai";
import * as Y from "yjs";
import { createGridEntry, getGridDefinitionTarget, setGridQuery } from "../../../shared/src/services/gridDefinition.js";
import {
    deferred,
    edit,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./observation-runtime.fixture.js";

const QUERY = "SELECT id, title, status, hidden FROM tasks WHERE status = 'todo' ORDER BY id";

describe("notification runtime failed evidence and incarnation recovery", function() {
    this.timeout(60_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    for (const invalidQuery of ["DELETE FROM tasks", "SELECT value FROM generate_series(1, 10001) AS value"]) {
        it(`retains a settled baseline across an actual ${invalidQuery.startsWith("DELETE") ? "invalid query" : "result limit"}`, async () => {
            f = await runtimeFixture();
            const { source, project } = await f.seed();
            f.runtime.start();
            await f.update([rule()]);
            await f.watching(["watch-grid"]);
            const target = getGridDefinitionTarget(project as never, "watched")!;
            await f.evaluated(() => setGridQuery(target, invalidQuery));
            expect(f.offered).to.have.length(0);
            expect(f.runtime.status(UID).some(status => status.state === "blocked"))
                .to.equal(true);
            expect(f.reads.at(-1)!.result.status).not.to.equal("ready");
            await f.evaluated(() => setGridQuery(target, QUERY));
            await f.watching(["watch-grid"]);
            expect(f.offered).to.have.length(0);
            edit(source, "B");
            await waitFor(() => f.offered.length === 1, 15_000);
            expect(JSON.stringify(f.offered[0].summary)).to.contain("B");
        });
    }

    it("discards a superseded capture and silently baselines a replacement source incarnation", async () => {
        const reached = deferred(), resume = deferred();
        let hold = false;
        f = await runtimeFixture({}, {
            beforeFinalCertification: async () => {
                if (!hold) return;
                hold = false;
                reached.resolve();
                await resume.promise;
            },
        });
        const { source, project } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
        hold = true;
        edit(source, "B");
        await reached.promise;
        try {
            project.getMap("yjsGrids").delete("watched");
            createGridEntry(project as never, "watched", {
                name: "Replacement grid",
                query: QUERY,
                components: { id: { hidden: true }, hidden: { hidden: true } },
            });
        } finally {
            resume.resolve();
        }
        await waitFor(
            () => f.reads.some(read => read.result.status === "stale" && read.result.reason === "incarnation_lost"),
            15_000,
        );
        await f.watching(["watch-grid"]);
        expect(f.offered).to.have.length(0);
        edit(source, "C");
        await waitFor(() => f.offered.length === 1, 15_000);
        edit(source, "B");
        expect((await f.offered[0].revalidate()).status).not.to.equal("current");
        f.offered[0].settleAttempt({ initiated: false, outcome: "cancelled" });
        await f.evaluated(() => edit(source, "B"));
        expect(f.offered).to.have.length(1);
    });

    it("loses unsent work across restart and stores only configuration plus normal source documents", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
        edit(source, "B");
        await waitFor(() => f.offered.length === 1, 15_000);
        const old = f.offered[0];
        const directory = f.directory;
        const db = f.server.persistence!.db!;
        const notificationTables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notification_%' ORDER BY name",
        ).all();
        expect(notificationTables).to.deep.equal([{ name: "notification_rules" }, {
            name: "notification_settings_heads",
        }]);
        const durableRules = db.prepare("SELECT * FROM notification_rules").all();
        expect(JSON.stringify(durableRules)).not.to.contain(old.eventId).and.not.contain("sourceVersionToken");
        await f.close();
        f = await runtimeFixture({}, {}, directory);
        f.runtime.start();
        await f.watching(["watch-grid"]);
        expect(f.offered).to.have.length(0);
        expect(f.server.notificationSettings.get(UID).rules).to.deep.equal([rule()]);
        expect((await old.revalidate()).status).not.to.equal("current");
        old.settleAttempt({ initiated: true, outcome: "unknown" });
        const connection = await f.server.hocuspocus.openDirectConnection(`projects/${PROJECT}/tables/tasks`, {
            context: { uid: UID },
        });
        f.connections.push(connection);
        const reopened = connection.document as unknown as Y.Doc;
        expect(reopened.getMap<Y.Map<unknown>>("data").get("a")!.get("title")).to.equal("B");
        edit(reopened, "C");
        await waitFor(() => f.offered.length === 1, 15_000);
        expect(f.offered[0].eventId).not.to.equal(old.eventId);
        edit(reopened, "B");
        expect((await f.offered[0].revalidate()).status).not.to.equal("current");
        f.offered[0].settleAttempt({ initiated: false, outcome: "cancelled" });
        await f.evaluated(() => edit(reopened, "B"));
        expect(f.offered).to.have.length(1);
    });
});
