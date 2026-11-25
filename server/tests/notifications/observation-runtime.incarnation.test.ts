import { expect } from "chai";
import * as Y from "yjs";
import { type DirectConnection, releaseWithoutStore } from "../../src/mcp/live-room.js";
import {
    edit,
    PROJECT,
    rule,
    type RuntimeFixture,
    runtimeFixture,
    UID,
    waitFor,
} from "./observation-runtime.fixture.js";

describe("notification runtime silent live-room replacement", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("finds a replaced source without an old-document update and silently establishes new continuity", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([rule()]);
        await f.watching(["watch-grid"]);
        const room = `projects/${PROJECT}/tables/tasks`;
        const saved = Y.encodeStateAsUpdate(source);
        releaseWithoutStore(f.connections[1] as unknown as DirectConnection);
        f.server.hocuspocus.documents.delete(room);
        const replacement = await f.server.hocuspocus.openDirectConnection(room, { context: { uid: UID } });
        f.connections[1] = replacement;
        const currentSource = replacement.document as unknown as Y.Doc;
        Y.applyUpdate(currentSource, saved);
        edit(currentSource, "B");
        await waitFor(
            () => f.reads.some(read => read.result.status === "stale" && read.result.reason === "incarnation_lost"),
            15_000,
        );
        await f.watching(["watch-grid"]);
        expect(f.offered).to.have.length(0);
        edit(currentSource, "C");
        await waitFor(() => f.offered.length === 1, 15_000);
        expect(JSON.stringify(f.offered[0].summary)).to.contain("C");
        edit(currentSource, "B");
        expect((await f.offered[0].revalidate()).status).not.to.equal("current");
        f.offered[0].settleAttempt({ initiated: false, outcome: "cancelled" });
        await f.evaluated(() => edit(currentSource, "B"));
        edit(source, "Detached source");
        await f.runtime.reconcile();
        expect(f.offered).to.have.length(1);
        expect(currentSource.getMap<Y.Map<unknown>>("data").get("a")!.get("title")).to.equal("B");
    });
});
