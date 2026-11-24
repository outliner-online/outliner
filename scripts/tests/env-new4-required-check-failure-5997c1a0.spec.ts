/** @feature ENV-5997c1a0 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const client = path.join(root, "client");
const workflowPath = path.join(root, ".github/workflows/ci-test-e2e.yml");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

function playwright(fixture: string, args: string[], environment: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [path.join(client, "node_modules/playwright/cli.js"), "test", ...args], {
        cwd: client,
        env: { ...process.env, ...environment },
        encoding: "utf8",
    });
}

test("a real failing native shard makes the production required-check invocation fail", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "new4-required-check-"));
    temporary.push(directory);
    const fixture = path.join(directory, "fixture");
    const evidence = path.join(directory, "new-4-evidence");
    fs.mkdirSync(fixture, { recursive: true });
    const playwrightModule = pathToFileURL(path.join(client, "node_modules/@playwright/test/index.mjs")).href;
    for (let index = 0; index < 12; index++) {
        fs.writeFileSync(path.join(fixture, `case-${index}.spec.mjs`), `
            import { test, expect } from ${JSON.stringify(playwrightModule)};
            test('case ${index}', () => expect(1).toBe(1));
        `);
    }
    const config = path.join(fixture, "playwright.config.mjs");
    fs.writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0,
        projects: [{ name: 'new-4', use: { browserName: 'chromium' } }] };`);
    const reporter = path.join(root, "scripts/ci/playwright-collection-reporter.mjs");
    const runId = "failure-control";
    const executionId = `${runId}-1`;
    const commit = "failure-control-sha";
    const inventories: string[] = [];
    for (const shard of [undefined, "1/2", "2/2"]) {
        const output = path.join(directory, shard ? `expected-${shard[0]}.json` : "full.json");
        inventories.push(output);
        const result = playwright(fixture, ["--config", config, "--list", "--project=new-4",
            ...(shard ? [`--shard=${shard}`] : []), `--reporter=${reporter}`], {
            PLAYWRIGHT_COLLECTION_E2E_DIR: fixture,
            PLAYWRIGHT_COLLECTION_OUTPUT: output,
        });
        expect(result.status, result.stderr).toBe(0);
    }
    const firstShard = JSON.parse(fs.readFileSync(inventories[1], "utf8"));
    expect(firstShard.cases.length).toBeGreaterThan(0);
    const failingFile = path.join(fixture, firstShard.cases[0].file);
    fs.writeFileSync(failingFile, fs.readFileSync(failingFile, "utf8").replace("toBe(1)", "toBe(2)"));

    const outcomes: Record<number, { attempt: number; conclusion: string; }> = {};
    for (const index of [1, 2]) {
        const logs = path.join(evidence, `e2e-artifacts-chromium-new-4-${index}-${executionId}`, "job_logs");
        fs.mkdirSync(logs, { recursive: true });
        fs.copyFileSync(inventories[0], path.join(logs, `new-4-full-${executionId}.json`));
        fs.copyFileSync(inventories[index], path.join(logs, `new-4-${index}-expected-${executionId}.json`));
        const executionReport = path.join(logs, `new-4-${index}-execution-${executionId}.json`);
        const result = playwright(fixture, ["--config", config, "--project=new-4", `--shard=${index}/2`,
            `--reporter=${path.join(root, "scripts/ci/new4-execution-reporter.mjs")}`], {
            E2E_BROWSER: "chromium",
            E2E_PROJECT: "new-4",
            E2E_EXECUTION_ID: executionId,
            GITHUB_SHA: commit,
            NEW4_CI_SHARD: `new-4-${index}`,
            NEW4_NATIVE_SHARD: `${index}/2`,
            NEW4_EXECUTION_REPORT: executionReport,
        });
        outcomes[index] = { attempt: 1, conclusion: result.status === 0 ? "success" : "failure" };
        fs.writeFileSync(path.join(logs, "execution-context.json"), JSON.stringify({
            browserEngine: "chromium",
            project: "new-4",
            ciShard: `new-4-${index}`,
            executionId,
            commit,
            status: result.status === 0 ? "success" : "failure",
        }));
    }
    expect(outcomes[1].conclusion).toBe("failure");
    expect(outcomes[2].conclusion).toBe("success");
    const outcomesFile = path.join(evidence, "outcomes.json");
    fs.writeFileSync(outcomesFile, JSON.stringify({ runId, currentAttempt: 1, shards: outcomes }));

    const workflow = parse(fs.readFileSync(workflowPath, "utf8"));
    const gate = workflow.jobs["new-4-complete"];
    const command = gate.steps.at(-1).run
        .replaceAll("new-4-evidence/outcomes.json", "__OUTCOMES__")
        .replaceAll("new-4-evidence", JSON.stringify(evidence))
        .replaceAll("__OUTCOMES__", JSON.stringify(outcomesFile))
        .replaceAll('"${{ github.run_id }}"', JSON.stringify(runId))
        .replaceAll('"${{ github.run_attempt }}"', '"1"')
        .replaceAll('"${{ github.sha }}"', JSON.stringify(commit));
    const requiredCheck = spawnSync("bash", ["-c", command], {
        cwd: root,
        env: { ...process.env, COLLECTION_RESULT: "success" },
        encoding: "utf8",
    });
    expect(requiredCheck.status).not.toBe(0);
    expect(requiredCheck.stderr).toContain("new-4-1 job concluded failure");

    const caller = parse(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
    expect(caller.jobs["e2e-test"].uses).toBe("./.github/workflows/ci-test-e2e.yml");
    expect(gate.name).toBe("e2e-test (new-4)");
    expect(workflow.jobs["e2e-test"].strategy.matrix.project.filter((name: string) => name.startsWith("firefox-")))
        .toEqual(["firefox-selection-core-4", "firefox-selection-core-4b", "firefox-selection-new",
            "firefox-selection-basic"]);
}, 60_000);
