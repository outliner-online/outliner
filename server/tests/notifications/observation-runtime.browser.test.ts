import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect } from "chai";
import * as Y from "yjs";
import { deferred, edit, rule, type RuntimeFixture, runtimeFixture, waitFor } from "./observation-runtime.fixture.js";

describe("notification runtime browser-compatible synchronization", function() {
    this.timeout(45_000);
    let f: RuntimeFixture;
    afterEach(async () => {
        await f?.close();
    });

    it("observes a real WebSocket writer and preserves observation after that client disconnects", async () => {
        f = await runtimeFixture();
        const { source } = await f.seed("demo");
        f.runtime.start();
        await f.update([rule("demo-watch", "demo")]);
        await f.watching(["demo-watch"]);
        const document = new Y.Doc();
        const room = "projects/demo/tables/tasks";
        const port = (f.server.server.address() as { port: number; }).port;
        const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/${room}`, name: room, document });
        try {
            const synced = deferred();
            provider.on("synced", () => synced.resolve());
            await synced.promise;
            edit(document, "Browser title");
            await waitFor(() => f.offered.length === 1, 15_000);
            expect(JSON.stringify(f.offered[0].summary)).to.contain("Browser title");
            expect(source.getMap<Y.Map<unknown>>("data").get("a")!.get("title")).to.equal("Browser title");
            f.offered[0].settleAttempt({ initiated: false, outcome: "no_destination" });
        } finally {
            provider.destroy();
            document.destroy();
        }
        await f.call("write_relation", {
            projectId: "demo",
            relation: "tasks",
            write: { op: "UPDATE", rowId: "a", column: "title", value: "After browser closed" },
        });
        await waitFor(() => f.offered.length === 2, 15_000);
        expect(JSON.stringify(f.offered[1].summary)).to.contain("After browser closed");
    });
});
