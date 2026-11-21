/** @feature ENV-5997c1a0 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifyNew4NativeShards } from "./helpers/new4-native-shards";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = path.join(root, ".github/workflows/ci-test-e2e.yml");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

describe("ENV-5997c1a0: complete native new-4 sharding", () => {
    it("collects the original Chromium selection exactly once across actual native shards", () => {
        const result = verifyNew4NativeShards(path.join(root, "client"), workflowPath);
        expect(result.expected).toBeGreaterThan(0);
        expect(result.halves.every(count => count > 0)).toBe(true);
    }, 120_000);

    it("preserves identity, bounded failure evidence, and the required aggregate check", () => {
        const workflow = parse(fs.readFileSync(workflowPath, "utf8"));
        const job = workflow.jobs["e2e-test"];
        expect(job.env.E2E_PROJECT).toContain("startsWith(matrix.project, 'new-4-') && 'new-4'");
        expect(job.env.E2E_EXECUTION_ID).toContain("github.run_attempt");
        const run = job.steps.find((step: { id?: string; }) => step.id === "tests").run;
        expect(run).toContain('elif [[ "$project" =~ ^new-4-([12])$ ]]; then');
        expect(run).toContain('--project=new-4 --shard="$shard"');
        expect(run).toContain("--reporter=line,list,json,html,../scripts/ci/new4-execution-reporter.mjs");
        expect(run).toContain(
            'PLAYWRIGHT_COLLECTION_OUTPUT="../job_logs/${project}-expected-${E2E_EXECUTION_ID}.json"',
        );
        expect(run).toContain("--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10");

        const gate = workflow.jobs["new-4-complete"];
        expect(gate.name).toBe("e2e-test (new-4)");
        expect(gate.needs).toEqual(["e2e-test", "selection-coverage"]);
        expect(gate.if).toBe("always()");
        const downloads = gate.steps.filter((step: { uses?: string; }) =>
            step.uses?.startsWith("actions/download-artifact@")
        );
        expect(downloads).toHaveLength(1);
        expect(downloads[0].with.pattern).toBe("e2e-artifacts-chromium-new-4-*-${{ github.run_id }}-*");
        expect(gate.permissions).toEqual({ actions: "read", contents: "read" });
        expect(gate.steps.some((step: { run?: string; }) => step.run?.includes("collect-new4-shard-outcomes.mjs")))
            .toBe(true);
        const upload = job.steps.find((step: { name?: string; }) => step.name === "Upload Logs & Artifacts");
        expect(upload.if).toContain("steps.tests.outputs.startup_verified == 'true'");
        expect(upload.if).toContain("startsWith(matrix.project, 'new-4-')");
        expect(upload.with["if-no-files-found"]).toContain("startsWith(matrix.project, 'new-4-')");
        const step = gate.steps.at(-1);
        expect(step.run).not.toContain("E2E_RESULT");
        for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
            const command = step.run.split("node scripts/ci/verify-new4-shards.mjs")[0];
            const result = spawnSync("bash", ["-euo", "pipefail", "-c", command], {
                env: { ...process.env, COLLECTION_RESULT: outcome },
            });
            expect(result.status, `COLLECTION_RESULT=${outcome}`).toBe(outcome === "success" ? 0 : 1);
        }
    });

    it("rejects missing, stale, duplicate, and failed execution evidence", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "new4-joined-evidence-"));
        temporary.push(directory);
        const run = "1234";
        const attempt = 1;
        const executionId = `${run}-${attempt}`;
        const commit = "head-sha";
        const cases = [
            { file: "new/j.spec.ts", line: 1, titles: ["first"] },
            { file: "new/s.spec.ts", line: 2, titles: ["second"] },
        ];
        for (const index of [1, 2]) {
            const logs = path.join(
                directory,
                `e2e-artifacts-chromium-new-4-${index}-${executionId}`,
                "job_logs",
            );
            fs.mkdirSync(logs, { recursive: true });
            const owned = [cases[index - 1]];
            fs.writeFileSync(path.join(logs, `new-4-full-${executionId}.json`), JSON.stringify({
                cases: cases.map(test => ({ ...test, project: "new-4", browser: "chromium" })),
            }));
            fs.writeFileSync(path.join(logs, `new-4-${index}-expected-${executionId}.json`), JSON.stringify({
                cases: owned.map(test => ({ ...test, project: "new-4", browser: "chromium" })),
            }));
            fs.writeFileSync(path.join(logs, "execution-context.json"), JSON.stringify({
                browserEngine: "chromium",
                project: "new-4",
                ciShard: `new-4-${index}`,
                executionId,
                commit,
                status: "success",
            }));
            fs.writeFileSync(path.join(logs, `new-4-${index}-execution-${executionId}.json`), JSON.stringify({
                mode: "execution",
                status: "passed",
                engine: "chromium",
                project: "new-4",
                ciShard: `new-4-${index}`,
                shard: `${index}/2`,
                executionId,
                commit,
                cases: owned.map(test => ({ ...test, attempts: [{ retry: 0, status: "passed" }] })),
            }));
        }
        const outcomesFile = path.join(directory, "outcomes.json");
        const writeOutcomes = (secondConclusion = "success", secondAttempt = attempt) =>
            fs.writeFileSync(outcomesFile, JSON.stringify({
                runId: run,
                currentAttempt: 2,
                shards: {
                    1: { attempt, conclusion: "success" },
                    2: { attempt: secondAttempt, conclusion: secondConclusion },
                },
            }));
        writeOutcomes();
        const verify = () =>
            spawnSync(process.execPath, [
                path.join(root, "scripts/ci/verify-new4-shards.mjs"),
                directory,
                outcomesFile,
                run,
                "2",
                commit,
            ], { encoding: "utf8" });
        expect(verify().status).toBe(0);
        for (const conclusion of ["failure", "cancelled", "skipped"]) {
            writeOutcomes(conclusion, 2);
            expect(verify().status, `latest new-4-2 outcome=${conclusion}`).not.toBe(0);
        }
        writeOutcomes();
        const report = path.join(
            directory,
            `e2e-artifacts-chromium-new-4-2-${executionId}/job_logs`,
            `new-4-2-execution-${executionId}.json`,
        );
        const original = fs.readFileSync(report, "utf8");
        fs.rmSync(report);
        expect(verify().status).not.toBe(0);
        fs.writeFileSync(report, original.replace('"commit":"head-sha"', '"commit":"stale"'));
        expect(verify().status).not.toBe(0);
        fs.writeFileSync(report, original.replace('"shard":"2/2"', '"shard":"1/2"'));
        expect(verify().status).not.toBe(0);
        fs.writeFileSync(report, original.replace('"engine":"chromium"', '"engine":"firefox"'));
        expect(verify().status).not.toBe(0);
        const failed = JSON.parse(original);
        failed.status = "failed";
        failed.cases.push(failed.cases[0]);
        fs.writeFileSync(report, JSON.stringify(failed));
        expect(verify().status).not.toBe(0);
    });
});
