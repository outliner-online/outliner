/** @feature ENV-934d0f2a
 * Verify ordinary CI's scheduling and command boundary; browser execution is
 * proved separately by the real Firefox runner regression tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const workflow = (name: string) => parse(fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8"));
const firefoxProjects = [
    "firefox-selection-core-4",
    "firefox-selection-core-4b",
    "firefox-selection-new",
    "firefox-selection-basic",
];
const chromiumProjects = [
    "basic",
    "core-1",
    "core-2",
    "core-3",
    "core-4",
    "core-4b",
    "core-5",
    "core-6",
    "core-7",
    "core-8",
    "new-1",
    "new-2",
    "new-3",
    "new-4",
    "new-5",
    "auth",
    "utils",
    "server",
    "yjs",
    "tables-1",
    "tables-2",
    "schedule",
    "onprem",
];

describe("ENV-934d0f2a: Firefox promotion to ordinary E2E CI", () => {
    it("schedules both engines in the same matrix without depending on Chromium success", () => {
        const ordinary = workflow("ci-test-e2e.yml");
        const job = ordinary.jobs["e2e-test"];
        expect(job.strategy.matrix.project).toEqual([...chromiumProjects, ...firefoxProjects]);
        expect(job.strategy["fail-fast"]).toBe(false);
        expect(job.needs).toBeUndefined();
        expect(job.if).toBeUndefined();
        expect(job["continue-on-error"]).toBeUndefined();
        expect(ordinary.jobs["selection-coverage"]).toBeDefined();
        const parent = workflow("ci.yml");
        expect(parent.jobs["e2e-test"].uses).toBe("./.github/workflows/ci-test-e2e.yml");
    });

    it("requires verified execution through the shared runner and preserves Chromium sharding", () => {
        const job = workflow("ci-test-e2e.yml").jobs["e2e-test"];
        const step = job.steps.find((value: { id?: string; }) => value.id === "tests");
        expect(step.if).toBeUndefined();
        expect(step["continue-on-error"]).toBeUndefined();
        expect(step.run).toContain("set -euo pipefail");
        expect(step.run).toContain('node scripts/run-firefox-selection.mjs --project="$project"');
        expect(step.run).toContain("scripts/test-onprem-client.sh");
        expect(step.run).toContain('--project=tables --shard="${BASH_REMATCH[1]}/2"');
        expect(step.run).toContain('npm run github:test:e2e -- --project="$project"');
        const setup = job.steps.find((value: { id?: string; }) => value.id === "setup");
        expect(setup.with.browser).toBe("${{ env.E2E_BROWSER }}");
    });

    it("keeps successful and failing Firefox evidence distinct across projects and attempts", () => {
        const job = workflow("ci-test-e2e.yml").jobs["e2e-test"];
        const upload = job.steps.find((value: { uses?: string; }) =>
            value.uses?.startsWith("actions/upload-artifact@")
        );
        expect(upload.if).toBe(
            "failure() || startsWith(matrix.project, 'firefox-') || matrix.project == 'new-2' || matrix.project == 'tables-1'",
        );
        for (const identity of ["env.E2E_BROWSER", "matrix.project", "github.run_id", "github.run_attempt"]) {
            expect(upload.with.name).toContain(`\${{ ${identity} }}`);
        }
        for (const directory of ["job_logs/", "client/test-results/", "server/logs/"]) {
            expect(upload.with.path).toContain(directory);
        }
        expect(job.env.E2E_EXECUTION_REPORT).toContain("${{ github.workspace }}/job_logs/");
        expect(job.env.E2E_EXPECTED_COLLECTION).toContain("${{ github.workspace }}/job_logs/");
    });

    it("bounds new-2 inside the unchanged job deadline and requires its archive", () => {
        const job = workflow("ci-test-e2e.yml").jobs["e2e-test"];
        expect(job["timeout-minutes"]).toBe(30);
        const step = job.steps.find((value: { id?: string; }) => value.id === "tests");
        expect(step.run).toContain('if [ "$project" = "new-2" ]; then');
        expect(step.run).toContain("python3 ../scripts/ci/run-bounded-e2e.py");
        expect(step.run).toContain("--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10");
        expect(step.run).toContain('--report="${PLAYWRIGHT_JSON_OUTPUT_NAME}"');
        const upload = job.steps.find((value: { uses?: string; }) =>
            value.uses?.startsWith("actions/upload-artifact@")
        );
        expect(upload.with["if-no-files-found"]).toBe(
            "${{ (matrix.project == 'new-2' || matrix.project == 'tables-1') && 'error' || 'warn' }}",
        );
    });

    it("bounds only tables-1 with its original shard and retains its successful evidence", () => {
        const job = workflow("ci-test-e2e.yml").jobs["e2e-test"];
        expect(job["timeout-minutes"]).toBe(30);
        const run = job.steps.find((value: { id?: string; }) => value.id === "tests").run;
        const tables = run.split('elif [ "$project" = "tables-1" ]; then')[1]
            .split('elif [[ "$project" =~ ^tables-([12])$ ]]; then')[0];
        expect(tables).toContain("python3 ../scripts/ci/run-bounded-e2e.py");
        expect(tables).toContain("--status=../job_logs/tables-1-command-status.json");
        expect(tables).toContain("--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10");
        expect(tables).toContain("-- npm run github:test:e2e -- --project=tables --shard=1/2");
        expect(run.match(/python3 \.\.\/scripts\/ci\/run-bounded-e2e\.py/g)).toHaveLength(2);
        expect(run).toContain('--project=tables --shard="${BASH_REMATCH[1]}/2"');
    });

    it("preserves the optional manual diagnostic without using it as ordinary execution", () => {
        const diagnostic = workflow("firefox-selection-diagnostic.yml");
        expect(Object.keys(diagnostic.on)).toEqual(["workflow_dispatch"]);
        const job = diagnostic.jobs["firefox-selection"];
        const checkout = job.steps.find((value: { uses?: string; }) => value.uses?.startsWith("actions/checkout@"));
        expect(checkout.with.ref).toBe("${{ inputs.revision }}");
        expect(job.strategy.matrix.project).toEqual(firefoxProjects);
    });
});
