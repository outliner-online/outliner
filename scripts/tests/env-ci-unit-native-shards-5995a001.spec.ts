import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-unit.yml"), "utf8"));
const runner = fs.readFileSync(path.join(root, "scripts/ci/run-unit-tests.sh"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "client/package.json"), "utf8"));

describe("unit CI native shard orchestration", () => {
    test("partitions the native unit project while retaining the stable aggregate check", () => {
        expect(workflow.jobs["unit-shard"].strategy["fail-fast"]).toBe(false);
        expect(workflow.jobs["unit-shard"].strategy.matrix.shard).toEqual([1, 2]);
        expect(workflow.jobs["unit-test"].needs).toBe("unit-shard");
        expect(workflow.jobs["unit-test"].if).toBe("always()");
        expect(workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Reject")).run)
            .toContain('test "$SHARD_RESULT" = success');
        expect(packageJson.scripts["github:test:unit"]).toBe("bash ../scripts/ci/run-unit-tests.sh");
        expect(runner).toContain("--reporter=json --outputFile.json");
        expect(runner).toContain("vitest run --project unit --coverage");
    });

    test("runs base exactly once and preserves native unit and base failures", () => {
        const env = workflow.jobs["unit-shard"].steps.find((step: any) => step.name === "Run unit test shard").env;
        expect(env.UNIT_RUN_BASE).toContain("matrix.shard == 1");
        expect(runner.match(/npm run test:base/g)).toHaveLength(1);
        expect(runner).not.toContain("retry");
        expect(runner).toMatch(/^set -euo pipefail$/m);
        expect(workflow.jobs["unit-shard"]["continue-on-error"]).toBeUndefined();
        expect(workflow.jobs["unit-test"]["continue-on-error"]).toBeUndefined();
    });

    test("binds non-empty selection and coverage evidence to the current run attempt", () => {
        const download = workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Download"));
        expect(download.with.pattern).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
        const verify = fs.readFileSync(path.join(root, "scripts/ci/verify-unit-shards.mjs"), "utf8");
        expect(verify).toContain("tests assigned more than once");
        expect(verify).toContain("shard selection differs from native selection");
        expect(verify).toContain("empty coverage");
        expect(verify).toContain("GITHUB_RUN_ID");
        expect(verify).toContain("mergedCoverage[file]");
    });

    test("shell syntax and workflow YAML remain valid", () => {
        execFileSync("bash", ["-n", path.join(root, "scripts/ci/run-unit-tests.sh")]);
        expect(workflow.jobs["unit-test"].steps).toBeDefined();
    });
});
