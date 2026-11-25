import fs from "node:fs";
import path from "node:path";

const [root, outcomesFile, runId, currentAttemptText, commit] = process.argv.slice(2);
const currentAttempt = Number(currentAttemptText);
if (!root || !outcomesFile || !runId || !Number.isInteger(currentAttempt) || currentAttempt < 1 || !commit) {
    throw new Error("usage: verify-new4-shards.mjs ROOT OUTCOMES RUN_ID CURRENT_ATTEMPT COMMIT");
}

function read(file, description) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        throw new Error(`Cannot read ${description} at ${file}: ${String(error)}`);
    }
}
const identity = test => JSON.stringify([test.file, test.line, ...test.titles]);
const failures = [];
const outcomes = read(outcomesFile, "native shard outcomes");
if (outcomes.runId !== runId || outcomes.currentAttempt !== currentAttempt) {
    failures.push("native shard outcomes belong to another workflow run or attempt");
}
let canonicalFull;
const joined = [];

for (const index of [1, 2]) {
    const prefix = `e2e-artifacts-chromium-new-4-${index}-${runId}-`;
    const outcome = outcomes.shards?.[index];
    if (!outcome || !Number.isInteger(outcome.attempt) || outcome.attempt > currentAttempt) {
        throw new Error(`No authoritative new-4-${index} job outcome exists for this run`);
    }
    if (outcome.conclusion !== "success") failures.push(`new-4-${index} job concluded ${outcome.conclusion}`);
    const executionId = `${runId}-${outcome.attempt}`;
    const directory = path.join(root, `${prefix}${outcome.attempt}`, "job_logs");
    const context = read(path.join(directory, "execution-context.json"), "execution context");
    const full = read(path.join(directory, `new-4-full-${executionId}.json`), "unsharded inventory");
    const expected = read(path.join(directory, `new-4-${index}-expected-${executionId}.json`), "shard inventory");
    const actual = read(path.join(directory, `new-4-${index}-execution-${executionId}.json`), "execution report");
    if (
        context.browserEngine !== "chromium" || context.project !== "new-4"
        || context.ciShard !== `new-4-${index}` || context.executionId !== executionId
        || context.commit !== commit || context.status !== "success"
    ) failures.push(`new-4-${index} execution context is stale or belongs to another source`);
    for (const inventory of [full, expected]) {
        if (!Array.isArray(inventory.cases) || !inventory.cases.length) failures.push("required inventory is empty");
        if (inventory.cases?.some(test => test.project !== "new-4" || test.browser !== "chromium")) {
            failures.push("inventory project or browser identity changed");
        }
    }
    const fullKeys = full.cases.map(identity);
    if (new Set(fullKeys).size !== fullKeys.length) failures.push("unsharded inventory contains duplicates");
    if (canonicalFull && JSON.stringify(fullKeys) !== JSON.stringify(canonicalFull)) {
        failures.push("shards disagree on the unsharded inventory");
    }
    canonicalFull = fullKeys;
    const expectedKeys = expected.cases.map(identity);
    const actualKeys = actual.cases?.map(identity) ?? [];
    if (new Set(expectedKeys).size !== expectedKeys.length) {
        failures.push(`new-4-${index} inventory contains duplicates`);
    }
    if (new Set(actualKeys).size !== actualKeys.length) failures.push(`new-4-${index} execution contains duplicates`);
    if (JSON.stringify(actualKeys.sort()) !== JSON.stringify(expectedKeys.sort())) {
        failures.push(`new-4-${index} executed identities do not equal its collected shard`);
    }
    if (
        actual.mode !== "execution" || actual.status !== "passed" || actual.engine !== "chromium"
        || actual.project !== "new-4" || actual.ciShard !== `new-4-${index}`
        || actual.shard !== `${index}/2` || actual.executionId !== executionId || actual.commit !== commit
    ) failures.push(`new-4-${index} execution report is stale or belongs to another source`);
    for (const test of actual.cases ?? []) {
        if (!Array.isArray(test.attempts) || !test.attempts.length || test.attempts.at(-1).status !== "passed") {
            failures.push(`new-4-${index} lacks a passing final attempt for ${identity(test)}`);
        }
        if (test.attempts.some((attempt, retry) => attempt.retry !== retry)) {
            failures.push(`new-4-${index} retry evidence is not ordered for ${identity(test)}`);
        }
    }
    joined.push(...expectedKeys);
}
if (new Set(joined).size !== joined.length) failures.push("the executed shard inventories overlap");
if (JSON.stringify(joined.sort()) !== JSON.stringify((canonicalFull ?? []).sort())) {
    failures.push("joined shard inventories do not equal the unsharded new-4 selection");
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(`Verified ${joined.length} exact new-4 Chromium cases across two execution artifacts`);
