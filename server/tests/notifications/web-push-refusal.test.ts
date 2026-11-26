import { expect } from "chai";
import * as Y from "yjs";
import type { CalendarObservationContextV1 } from "../../../shared/src/notifications/calendarProjection.js";
import { computeViewRange } from "../../../shared/src/services/calendarGridRange.js";
import { RuntimeClock } from "./observation-runtime.clock.js";
import { calendarRule, deferred, edit, UID, waitFor } from "./observation-runtime.fixture.js";
import { decryptPush } from "./web-push-crypto.fixture.js";
import { mobileRule, type WebPushFixture, webPushFixture } from "./web-push.fixture.js";

describe("Web Push terminal local refusals", function() {
    this.timeout(60_000);
    let f: WebPushFixture;
    afterEach(async () => f?.close());

    for (const phase of ["before", "after"] as const) {
        it(`settles lease expiry ${phase} revalidation without a write or repeat of unchanged B`, async () => {
            const clock = new RuntimeClock();
            const reached = deferred(), resume = deferred();
            let held = false;
            const hold = async (_input: unknown, index: number) => {
                if (index !== 0) return;
                held = true;
                reached.resolve();
                await resume.promise;
            };
            f = await webPushFixture({
                runtimeOptions: { clock, reconcileMs: 60_000, attemptTimeoutMs: 1000 },
                transportControls: phase === "before" ? { beforeAuthorize: hold } : { afterAuthorize: hold },
            });
            const receiver = await f.enroll();
            const { source } = await f.seed();
            f.runtime.start();
            await f.update([mobileRule()]);
            await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
            edit(source, "B");
            await clock.until(() => held);
            await reached.promise;
            await clock.advance(1001);
            resume.resolve();
            await waitFor(() => f.settlements.length === 1);
            expect(f.settlements).to.deep.equal([{ initiated: false, outcome: "expired" }]);
            expect(f.captured.requests).to.have.length(0);
            await clock.advance(60_000);
            await waitFor(() => f.runtime.diagnostics().evaluating === 0 && f.runtime.diagnostics().candidates === 0);
            expect(f.captured.calls).to.have.length(1);
            expect(f.settlements).to.have.length(1);
            edit(source, "C");
            await clock.until(() => f.settlements.length === 2);
            expect(f.captured.requests).to.have.length(1);
            expect(decryptPush(f.captured.requests[0], receiver).payload.body).to.contain("C");
        });
    }

    it("does not treat a changed source as terminal expiry when both invalidate the final write", async () => {
        const clock = new RuntimeClock();
        const resume = deferred();
        let held = false;
        f = await webPushFixture({
            runtimeOptions: { clock, reconcileMs: 60_000, attemptTimeoutMs: 1000 },
            transportControls: {
                afterAuthorize: async (_input, index) => {
                    if (index !== 0) return;
                    held = true;
                    await resume.promise;
                },
            },
        });
        const receiver = await f.enroll();
        const { source } = await f.seed();
        f.runtime.start();
        await f.update([mobileRule()]);
        await clock.until(() => f.runtime.status(UID).some(status => status.state === "watching"));
        edit(source, "B");
        await clock.until(() => held);
        await clock.advance(1001);
        edit(source, "C");
        resume.resolve();
        await waitFor(() => f.settlements.length === 1);
        expect(f.settlements).to.deep.equal([{ initiated: false, outcome: "deferred" }]);
        expect(f.captured.requests).to.have.length(0);
        await clock.until(() => f.settlements.length === 2);
        expect(f.captured.requests).to.have.length(1);
        expect(decryptPush(f.captured.requests[0], receiver).payload.body).to.contain("C");
    });

    it("refuses an oversized required Calendar context without substituting a generic notification or link", async () => {
        f = await webPushFixture();
        const receiver = await f.enroll();
        const { project, source } = await f.seed();
        const calendar = calendarRule();
        const original = calendar.context as CalendarObservationContextV1;
        const range = computeViewRange(original.anchorUtcMs, "month", original.weekStart, original.timeZone);
        const requiredLane = "required-filter-".repeat(250);
        const definition = project.getMap<Y.Map<unknown>>("calendars").get("calendar")!;
        definition.set("groupAxes", ["status"]);
        definition.set("query", "SELECT id AS source_id, 'tasks' AS source_kind, title, starts, status FROM tasks "
            + "WHERE starts >= current_setting('view.range_start')::date AND starts < current_setting('view.range_end')::date");
        edit(source, requiredLane, "a", "status");
        const watched = mobileRule({
            ...calendar,
            context: {
                ...original,
                viewType: "month",
                rangeStartUtcMs: range.start,
                rangeEndUtcMs: range.end,
                monthLaneFilter: requiredLane,
            },
        });
        f.runtime.start();
        await f.update([watched]);
        await f.watching([calendar.ruleId]);
        definition.set("name", "A displayed Calendar title changed");
        await waitFor(() => f.settlements.length === 1, 20_000);
        expect(f.settlements).to.deep.equal([{ initiated: false, outcome: "failed" }]);
        expect(f.captured.calls).to.have.length(0);
        const ready = f.reads.findLast(read => read.objectId === "calendar" && read.result.status === "ready")!.result;
        expect(ready.status).to.equal("ready");
        if (ready.status !== "ready") throw new Error("Expected complete authoritative Calendar projection");
        expect(ready.deepLink.length).to.be.greaterThan(3000);
        expect(ready.projection.title).to.equal("A displayed Calendar title changed");
        await f.evaluated(() => edit(source, "SECRET-context", "a", "hidden"), "calendar");
        expect(f.settlements).to.have.length(1);
        expect(f.captured.requests).to.have.length(0);
        await f.update([mobileRule(calendar)]);
        await f.watching([calendar.ruleId]);
        definition.set("name", "A later representable Calendar change");
        await waitFor(() => f.settlements.length === 2, 20_000);
        expect(f.captured.requests).to.have.length(1);
        const payload = decryptPush(f.captured.requests[0], receiver).payload;
        expect(payload.body).to.contain("A later representable Calendar change");
        expect(JSON.parse(new URL(payload.href, "https://outliner.example.test").searchParams.get("context")!))
            .to.deep.equal(calendar.context);
    });
});
