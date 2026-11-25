import { expect } from "chai";
import type { CalendarVisibleProjection } from "../../../shared/src/notifications/calendarProjection.js";
import { type GridVisibleProjection, projectGridTable } from "../../../shared/src/notifications/gridProjection.js";
import { createKanbanVisibleProjection } from "../../../shared/src/notifications/kanbanProjection.js";
import { summarizeViewChange, visibleProjectionsEqual } from "../../src/notifications/prepared-view-change.js";

function grid(values: string[], hidden = "hidden-sentinel"): GridVisibleProjection {
    const result = projectGridTable({
        title: "Records",
        context: { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" },
        columns: ["value", "hidden"],
        rows: values.map(value => ({ value, hidden })),
        rowTargets: values.map((_, index) => ({ logicalRowId: `private-${index}` })),
        columnOrder: ["value", "hidden"],
        hiddenColumns: { hidden: true },
        columnLabels: { value: "Value" },
        componentTypes: { value: "text" },
        resultColumns: [{ name: "value", typeId: 25 }, { name: "hidden", typeId: 25 }],
        physicalColumns: [],
        metadataStatus: "relation-free",
    });
    if (result.status !== "ready") throw new Error(result.reason);
    return result.projection;
}

function kanban(group: string) {
    const result = createKanbanVisibleProjection({
        rows: [{ status: group, title: "Visible task", detail: "Visible detail", secret: "hidden-sentinel" }],
        settings: {
            name: "Work",
            groupField: "status",
            titleField: "title",
            detailFields: ["detail"],
            laneOrder: ["Open", "Done"],
        },
        declaredGroupingChoices: ["Open", "Done"],
        columns: ["status", "title", "detail", "secret"],
        readiness: { status: "ready", complete: true, current: true },
    }, { version: 1, surface: "board", locale: "en-US", timeZone: "UTC" });
    if (result.status !== "ready") throw new Error(result.reason);
    return result.content;
}

describe("prepared visible-change summaries", () => {
    it("compares the actual displayed Grid projection and never includes hidden fields", () => {
        const before = grid(["A", "B"]);
        const hiddenChange = grid(["A", "B"], "different-secret");
        expect(visibleProjectionsEqual(before, hiddenChange)).to.equal(true);
        expect(summarizeViewChange(before, hiddenChange).counts.changedItems).to.equal(0);
        const after = grid(["B", "A"], "different-secret");
        expect(visibleProjectionsEqual(before, after)).to.equal(false);
        const summary = summarizeViewChange(before, after);
        expect(summary.counts).to.deep.equal({ previousItems: 2, currentItems: 2, changedItems: 2, changedLabels: 0 });
        expect(summary.examples).to.deep.equal([
            { text: "Changed: Value: B", truncated: false },
            { text: "Changed: Value: A", truncated: false },
        ]);
        expect(JSON.stringify(summary)).not.to.match(/secret|private|hidden/);
        expect(Object.isFrozen(summary.counts)).to.equal(true);
        expect(Object.isFrozen(summary.examples[0])).to.equal(true);
    });

    it("counts label and membership changes while returning at most three examples", () => {
        const before = grid(["A"]);
        const after = { ...grid(["B", "C", "D"]), title: "Renamed", columns: [{ label: "New label" }] };
        const summary = summarizeViewChange(before, after);
        expect(summary.counts).to.deep.equal({ previousItems: 1, currentItems: 3, changedItems: 3, changedLabels: 2 });
        expect(summary.examples.map(example => example.text)).to.deep.equal([
            "Changed: Renamed",
            "Changed: New label",
            "Changed: New label: B",
        ]);
        expect(summary.examplesTruncated).to.equal(true);
        expect(summarizeViewChange(grid(["A"]), grid([])).examples).to.deep.equal([
            { text: "Removed: Value: A", truncated: false },
        ]);
    });

    it("bounds example strings by Unicode code points, including the truncation marker", () => {
        const prefixLength = [..."Changed: Value: "].length;
        const exact = summarizeViewChange(grid(["A"]), grid(["😀".repeat(120 - prefixLength)])).examples[0]!;
        expect([...exact.text]).to.have.length(120);
        expect(exact.truncated).to.equal(false);
        const longer = summarizeViewChange(grid(["A"]), grid(["😀".repeat(121 - prefixLength)])).examples[0]!;
        expect([...longer.text]).to.have.length(120);
        expect(longer.text.endsWith("😀…")).to.equal(true);
        expect(longer.truncated).to.equal(true);
    });

    it("reports actual Kanban lane membership changes using only rendered card fields", () => {
        const summary = summarizeViewChange(kanban("Open"), kanban("Done"));
        expect(summary.counts).to.deep.equal({ previousItems: 1, currentItems: 1, changedItems: 1, changedLabels: 0 });
        expect(summary.examples).to.deep.equal([
            { text: "Changed: Done: Visible task; detail: Visible detail", truncated: false },
        ]);
        expect(JSON.stringify(summary)).not.to.contain("hidden-sentinel");
    });

    it("detects Calendar geometry changes but summarizes displayed text only", () => {
        const before: CalendarVisibleProjection = {
            version: 1,
            title: "Calendar",
            rangeLabel: "November 21",
            modeLabel: "Day",
            labels: ["09:00"],
            content: [{ kind: "timed", title: "Meeting", start: 0.25, end: 0.5 }],
        };
        const after = { ...before, content: [{ kind: "timed", title: "Meeting", start: 0.5, end: 0.75 }] };
        expect(visibleProjectionsEqual(before, after)).to.equal(false);
        const summary = summarizeViewChange(before, after);
        expect(summary.counts.changedItems).to.equal(1);
        expect(summary.examples).to.deep.equal([{ text: "Changed: Meeting", truncated: false }]);
        expect(JSON.stringify(summary)).not.to.match(/timed|0\.5|0\.75/);
    });
});
