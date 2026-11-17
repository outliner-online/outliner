import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { rolloutFixture } from "./helpers/firebase-rollout-fixture";

const root = resolve(import.meta.dirname, "../..");

/** @feature ENV-a71c9e40 */
describe("serial Firebase rollout executable contract", () => {
    test("deploys every Function once, verifies before the next and preserves other targets", () => {
        const f = rolloutFixture(root);
        const r = f.execute();
        expect(r.status, r.stderr).toBe(0);
        const calls = f.calls();
        expect(calls.filter(c => c[0] === "firebase")).toEqual([
            ["firebase", "functions:first"],
            ["firebase", "functions:second"],
            ["firebase", "hosting,firestore:rules,storage"],
        ]);
        const firstStorage = calls.findIndex(c => c[0] === "gcloud" && c[1] === "storage");
        const secondDeploy = calls.findIndex(c => c[1] === "functions:second");
        expect(firstStorage).toBeGreaterThan(0);
        expect(firstStorage).toBeLessThan(secondDeploy);
        expect(f.receipt().phase).toBe("COMPLETE");
        expect(f.receipt().functions.map((x: { phase: string; }) => x.phase)).toEqual(["VERIFIED", "VERIFIED"]);
        const count = calls.length;
        expect(f.execute().status).not.toBe(0);
        expect(f.calls()).toHaveLength(count); // duplicate invocation cannot issue another deploy
    });

    test.each([
        "command-failure",
        "active-version-text",
        "unready",
        "old-traffic",
        "split-traffic",
        "wrong-project",
        "wrong-source",
        "wrong-dependency",
        "missing-source",
        "duplicate-source",
        "invalid-zip",
        "storage-failure",
        "timeout",
    ])("%s stops visibly without retry, later Functions or Hosting", scenario => {
        const f = rolloutFixture(root, scenario);
        const r = f.execute();
        expect(r.status).not.toBe(0);
        expect(f.calls().filter(c => c[0] === "firebase")).toEqual([["firebase", "functions:first"]]);
        expect(f.receipt().phase).toBe("FAILED_OR_UNCONFIRMED");
        expect(JSON.stringify(f.receipt())).not.toContain("must-not-be-retained");
        if (scenario === "timeout") expect(f.receipt().error).toContain("outcome may be unknown");
    });

    test.each(["second-failure", "other-failure"])("%s remains failure after prior successes", scenario => {
        const f = rolloutFixture(root, scenario);
        expect(f.execute().status).not.toBe(0);
        expect(f.receipt().phase).toBe("FAILED_OR_UNCONFIRMED");
        expect(f.calls().filter(c => c[0] === "firebase")).toHaveLength(scenario === "second-failure" ? 2 : 3);
    });

    test("late revision drift is caught by the final complete recheck before Hosting", () => {
        const f = rolloutFixture(root, "late-drift");
        expect(f.execute().status).not.toBe(0);
        expect(f.calls().filter(c => c[0] === "firebase")).toEqual([
            ["firebase", "functions:first"],
            ["firebase", "functions:second"],
        ]);
        expect(f.receipt().error).toContain("not Ready");
        expect(f.receipt().functions[0].phase).toBe("VERIFYING");
    });

    test("new static Function declarations are included instead of silently omitted", () => {
        const f = rolloutFixture(root, "success",
            "exports.first = onRequest(() => {}); exports.second = onRequest(() => {}); exports.added = onRequest(() => {});");
        expect(f.execute().status).toBe(0);
        expect(f.calls().filter(c => c[0] === "firebase").map(c => c[1])).toEqual([
            "functions:first",
            "functions:second",
            "functions:added",
            "hosting,firestore:rules,storage",
        ]);
    });

    test("removed declarations cannot silently leave an old endpoint deployed", () => {
        const f = rolloutFixture(root, "retired-function");
        expect(f.execute().status).not.toBe(0);
        expect(f.calls().filter(c => c[0] === "firebase")).toEqual([]);
        expect(f.receipt().error).toContain("retirement plan");
    });

    test.each([
        "",
        "exports.x = onRequest(() => {}); exports.x = onRequest(() => {});",
        "exports[key] = onRequest(() => {});",
        "module.exports = { x: onRequest(() => {}) };",
        "exports.x = onRequest(options, () => {});",
        "exports.x = onRequest({region: 'other'}, () => {});",
        "exports.x = onRequest(() => {}); Object.assign(exports, more);",
    ])("unsupported inventory fails before any deployment: %s", source => {
        const f = rolloutFixture(root);
        writeFileSync(resolve(f.dir, "functions/index.js"), source);
        expect(f.execute().status).not.toBe(0);
        expect(f.calls()).toEqual([]);
    });
});

test("actual repository inventory covers all 26 current Functions without executing initialization", () => {
    const result = spawnSync("node", [resolve(root, "scripts/firebase-function-targets.cjs")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const targets = JSON.parse(result.stdout);
    expect(targets).toHaveLength(26);
    expect(new Set(targets.map((t: { name: string; }) => t.name)).size).toBe(26);
    expect(targets.every((t: { region: string; }) => t.region === "us-central1")).toBe(true);
});

test("automatic deployment stays CI-gated, pinned, serialized, bounded and evidence-retaining", () => {
    const workflow = parse(readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8"));
    expect(workflow.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"], branches: ["main"] });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency.group).toBe("firebase-outliner-d57b0");
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow.jobs.deploy["timeout-minutes"]).toBe(90);
    const steps = workflow.jobs.deploy.steps;
    expect(steps.find((s: { name: string; }) => s.name === "Checkout code").with.ref)
        .toContain("github.event.workflow_run.head_sha");
    expect(steps.find((s: { name: string; }) => s.name === "Deploy to Firebase").run).toContain(
        "deploy-firebase-serial.py",
    );
    expect(steps.find((s: { name: string; }) => s.name === "Preserve rollout evidence").if).toContain("always()");
    expect(steps.find((s: { name: string; }) => s.name === "Preserve rollout evidence").with.archive).toBe(true);
    expect(steps.find((s: { name: string; }) => s.name === "Lint functions").run).not.toContain("--fix");
    const ci = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
    expect(JSON.stringify(ci.jobs["firebase-rollout-contract"])).toContain(
        "env-firebase-serial-rollout-a71c9e40.spec.ts",
    );
});
