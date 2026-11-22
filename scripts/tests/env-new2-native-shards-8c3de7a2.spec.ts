/** @feature ENV-8c3de7a2 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createCollectionFixture } from "./helpers/firefox-collection-fixture";
import { verifyNew2NativeShards } from "./helpers/new2-native-shards";

const root = fileURLToPath(new URL("../../", import.meta.url));
let fixture: ReturnType<typeof createCollectionFixture> | undefined;
afterEach(() => fixture?.dispose());
function probes() {
    fixture = createCollectionFixture();
    fixture.addSpec("new/Clipboard-8c3de7a2.spec.ts", ["first case", "second case"]);
    fixture.addSpec("new/cross-project-8c3de7a2.spec.ts", ["first case", "second case"]);
    return fixture;
}

describe("ENV-8c3de7a2: complete native new-2 sharding", () => {
    it("collects the complete real old selection exactly once across actual native shards", () => {
        const result = verifyNew2NativeShards(path.join(root, "client"),
            path.join(root, ".github/workflows/ci-test-e2e.yml"));
        expect(result.expected).toBeGreaterThan(0);
        expect(result.halves.every(count => count > 0)).toBe(true);
    }, 120_000);

    it("preserves uppercase names in both native file groups", () => {
        const f = probes();
        expect(verifyNew2NativeShards(f.client, f.workflow)).toEqual({ expected: 4, halves: [2, 2] });
    }, 120_000);

    it("rejects a case filtered from both actual CI invocations", () => {
        const f = probes();
        f.mutateProjects('project.name === "new-2" ? { ...project, grepInvert: /second case/ } : project');
        expect(() => verifyNew2NativeShards(f.client, f.workflow)).toThrow(/shard mismatch: missing/);
    }, 120_000);

    it("rejects missing or duplicate CI rows instead of trusting local collection", () => {
        const f = probes();
        f.removeCIProject("new-2-2");
        expect(() => verifyNew2NativeShards(f.client, f.workflow)).toThrow(/schedule new-2-2 exactly once/);
        const document = parse(fs.readFileSync(f.workflow, "utf8"));
        document.jobs["e2e-test"].strategy.matrix.project.push("new-2-2", "new-2-2");
        fs.writeFileSync(f.workflow, stringify(document));
        expect(() => verifyNew2NativeShards(f.client, f.workflow)).toThrow(/schedule new-2-2 exactly once/);
    }, 120_000);

    it("summarises the actual shard log while the Playwright project retains its old name", () => {
        const f = probes();
        const workflow = parse(fs.readFileSync(f.workflow, "utf8"));
        const summary = workflow.jobs["e2e-test"].steps.find((step: { name?: string; }) =>
            step.name === "Summarise failures"
        );
        fs.mkdirSync(path.join(f.root, "job_logs"));
        for (const shard of ["new-2-1", "new-2-2"]) {
            const report = path.join(f.root, `${shard}-summary.md`);
            fs.writeFileSync(path.join(f.root, `job_logs/e2e-chromium-${shard}-run-attempt.log`),
                `FAIL ${shard} sentinel\ndetail\n`);
            const result = spawnSync("bash", ["-euo", "pipefail", "-c",
                summary.run.replaceAll("${{ matrix.project }}", shard)], {
                cwd: f.root,
                env: {
                    ...process.env,
                    E2E_BROWSER: "chromium",
                    E2E_PROJECT: "new-2",
                    E2E_EXECUTION_ID: "run-attempt",
                    GITHUB_STEP_SUMMARY: report,
                },
            });
            expect(result.status).toBe(0);
            expect(fs.readFileSync(report, "utf8")).toContain(`FAIL ${shard} sentinel`);
        }
    });

    it("keeps the shipped native selection, followups exactly once, evidence and old-name gate", () => {
        const workflow = parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-e2e.yml"), "utf8"));
        const job = workflow.jobs["e2e-test"];
        expect(job["timeout-minutes"]).toBe(30);
        expect(job.strategy["fail-fast"]).toBe(false);
        expect(job.env.E2E_PROJECT).toContain("startsWith(matrix.project, 'new-2-') && 'new-2'");
        const run = job.steps.find((step: { id?: string; }) => step.id === "tests").run;
        expect(run).toContain('if [[ "$project" =~ ^new-2-([12])$ ]]; then');
        expect(run).toContain('shard="${BASH_REMATCH[1]}/2"');
        expect(run).toContain('--project=new-2 --shard="$shard" --reporter=line,list,json,html');
        expect(run).toContain("--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10");
        const followup = job.steps.find((step: { name?: string; }) =>
            step.name === "Record retry-free Grid clipboard verification"
        );
        expect(followup.if).toBe("matrix.project == 'new-2-1'");
        expect(followup.run.match(/--project=new-2/g)).toHaveLength(2);
        expect(followup.run.match(/--retries=0/g)).toHaveLength(2);
        expect(followup.run).toContain("--repeat-each=10");
        expect(followup.run).toContain("grid-clipboard-full-spec-results");
        const gate = workflow.jobs["new-2-complete"];
        expect(gate.name).toBe("e2e-test (new-2)");
        expect(gate.needs).toEqual(["e2e-test", "selection-coverage"]);
        expect(gate.if).toBe("always()");
        expect(gate["continue-on-error"]).toBeUndefined();
        const step = gate.steps[0];
        expect(step.env.E2E_RESULT).toBe("${{ needs.e2e-test.result }}");
        expect(step.env.COLLECTION_RESULT).toBe("${{ needs.selection-coverage.result }}");
        for (const input of ["E2E_RESULT", "COLLECTION_RESULT"]) {
            for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
                const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
                    env: { ...process.env, E2E_RESULT: "success", COLLECTION_RESULT: "success", [input]: outcome },
                });
                expect(result.status, `${input}=${outcome}`).toBe(outcome === "success" ? 0 : 1);
            }
        }
    });
});
