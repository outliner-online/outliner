/** @feature ENV-5997c1a0 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { collectNew4ShardOutcomes } from "../ci/collect-new4-shard-outcomes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

const job = (index: number, startedAt: string, conclusion = "success") => ({
    id: Number(`${index}${startedAt === "2026-11-21T10:01:00Z" ? 1 : 2}`),
    name: `e2e-test / e2e-test (new-4-${index})`,
    started_at: startedAt,
    conclusion,
});

function observedAttemptFetch(rerunSecondShard: boolean) {
    const payloads = new Map([
        ["/attempts/1", { run_started_at: "2026-11-21T10:00:00Z" }],
        ["/attempts/1/jobs", { jobs: [job(1, "2026-11-21T10:01:00Z"), job(2, "2026-11-21T10:01:00Z")] }],
        ["/attempts/2", { run_started_at: "2026-11-21T11:00:00Z" }],
        ["/attempts/2/jobs", {
            jobs: [
                // GitHub repeats retained jobs in the later attempt response with their original timestamps.
                job(1, "2026-11-21T10:01:00Z"),
                job(2, "2026-11-21T10:01:00Z"),
                ...(rerunSecondShard ? [job(2, "2026-11-21T11:01:00Z", "failure")] : []),
            ],
        }],
    ]);
    return async (url: string) => {
        const suffix = [...payloads.keys()].find(key =>
            url.includes(key) && (key.endsWith("jobs") === url.includes("/jobs"))
        );
        const payload = suffix && payloads.get(suffix);
        return { ok: Boolean(payload), status: payload ? 200 : 404, json: async () => payload };
    };
}

function writeAttemptOneArtifacts(directory: string, runId: string, commit: string) {
    const cases = [
        { file: "new/first.spec.ts", line: 1, titles: ["first"] },
        { file: "new/second.spec.ts", line: 2, titles: ["second"] },
    ];
    for (const index of [1, 2]) {
        const executionId = `${runId}-1`;
        const logs = path.join(directory, `e2e-artifacts-chromium-new-4-${index}-${executionId}`, "job_logs");
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
}

function runRequiredCheck(directory: string, outcomesFile: string, runId: string, commit: string) {
    const workflow = parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-e2e.yml"), "utf8"));
    const step = workflow.jobs["new-4-complete"].steps.at(-1);
    const command = step.run
        .replaceAll("new-4-evidence/outcomes.json", "__OUTCOMES_FILE__")
        .replaceAll("new-4-evidence", JSON.stringify(directory))
        .replaceAll("__OUTCOMES_FILE__", JSON.stringify(outcomesFile))
        .replaceAll('"${{ github.run_id }}"', JSON.stringify(runId))
        .replaceAll('"${{ github.run_attempt }}"', '"2"')
        .replaceAll('"${{ github.sha }}"', JSON.stringify(commit));
    return spawnSync("bash", ["-c", command], {
        cwd: root,
        env: { ...process.env, COLLECTION_RESULT: "success" },
    });
}

describe("ENV-5997c1a0: failed-job rerun provenance", () => {
    it.each([
        [false, 0, "retains successful evidence when neither target shard reruns"],
        [true, 1, "rejects stale success when a target shard genuinely reruns and fails"],
    ])("%s", async (rerunSecondShard, expectedStatus, _description) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "new4-rerun-"));
        temporary.push(directory);
        const runId = "44926075930";
        const commit = "merge-head";
        writeAttemptOneArtifacts(directory, runId, commit);
        const outcomes = await collectNew4ShardOutcomes(
            "outliner-online/outliner",
            runId,
            2,
            "fixture-token",
            observedAttemptFetch(rerunSecondShard),
        );
        const outcomesFile = path.join(directory, "outcomes.json");
        fs.writeFileSync(outcomesFile, JSON.stringify(outcomes));
        // Execute the exact final step of the production required-check job,
        // rather than bypassing that wiring by invoking the verifier directly.
        const result = runRequiredCheck(directory, outcomesFile, runId, commit);
        expect(result.status).toBe(expectedStatus);
        expect(outcomes.shards[1].attempt).toBe(1);
        expect(outcomes.shards[2].attempt).toBe(rerunSecondShard ? 2 : 1);
    });

    it("keeps the calling workflow and unchanged Firefox verification connected", () => {
        const caller = parse(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
        expect(caller.jobs["e2e-test"].uses).toBe("./.github/workflows/ci-test-e2e.yml");
        const reusable = parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-e2e.yml"), "utf8"));
        const projects = reusable.jobs["e2e-test"].strategy.matrix.project;
        expect(projects.filter((project: string) => project.startsWith("firefox-selection-"))).toEqual([
            "firefox-selection-core-4",
            "firefox-selection-core-4b",
            "firefox-selection-new",
            "firefox-selection-basic",
        ]);
        expect(reusable.jobs["new-4-complete"].name).toBe("e2e-test (new-4)");
    });
});
