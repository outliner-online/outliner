/** @feature ENV-5997c1a0 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifyNew4NativeShards } from "./helpers/new4-native-shards";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = path.join(root, ".github/workflows/ci-test-e2e.yml");

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
        expect(run).toContain('--project=new-4 --shard="$shard" --reporter=line,list,json,html');
        expect(run).toContain("--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10");

        const gate = workflow.jobs["new-4-complete"];
        expect(gate.name).toBe("e2e-test (new-4)");
        expect(gate.needs).toEqual(["e2e-test", "selection-coverage"]);
        expect(gate.if).toBe("always()");
        const step = gate.steps[0];
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
