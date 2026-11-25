import fs from "node:fs";
import path from "node:path";

const [root, totalText] = process.argv.slice(2);
if (!root || !totalText) throw new Error("usage: verify-server-test-shards.mjs RESULTS TOTAL");
const total = Number(totalText);
const failures = [];
let canonical;
const executed = [];
for (let index = 1; index <= total; index++) {
    const directory = path.join(root, `shard-${index}`);
    const read = name => {
        try {
            return JSON.parse(fs.readFileSync(path.join(directory, name)));
        } catch {
            failures.push(`shard ${index} has missing or invalid ${name}`);
            return undefined;
        }
    };
    const outcome = read("outcome.json");
    const full = read("full.json");
    const actual = read("executed.json");
    const expectedIdentity = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "local"}:${
        process.env.GITHUB_SHA ?? "local"
    }`;
    const outcomeIsValid = outcome !== null && typeof outcome === "object" && !Array.isArray(outcome);
    const fullIsValid = full !== null && typeof full === "object" && !Array.isArray(full) && Array.isArray(full.tests);
    const actualIsValid = actual !== null && typeof actual === "object" && !Array.isArray(actual)
        && Array.isArray(actual.tests);
    if (!outcomeIsValid) failures.push(`shard ${index} has invalid outcome evidence`);
    if (!fullIsValid) failures.push(`shard ${index} has invalid unsplit inventory evidence`);
    if (!actualIsValid) failures.push(`shard ${index} has invalid executed test evidence`);
    if (outcomeIsValid) {
        const identity = `${outcome.runId}:${outcome.runAttempt}:${outcome.commit}`;
        if (identity !== expectedIdentity) failures.push(`shard ${index} result is stale (${identity})`);
        if (outcome.shard !== `${index}/${total}`) failures.push(`shard ${index} has the wrong shard identity`);
        if (outcome.status !== 0) failures.push(`shard ${index} native Mocha exit was ${outcome.status}`);
    }
    if (fullIsValid && full.tests.length === 0) {
        failures.push(`shard ${index} has no native tests in the unsplit inventory`);
    }
    if (actualIsValid && actual.tests.length === 0) {
        failures.push(`shard ${index} has no executed native tests`);
    }
    const fullKeys = fullIsValid
        ? full.tests.map(test => `${test.file}\0${test.title}`).sort()
        : undefined;
    if (fullKeys && new Set(fullKeys).size !== fullKeys.length) {
        failures.push("unsharded inventory contains duplicate native identities");
    }
    if (!canonical && fullKeys) canonical = fullKeys;
    else if (fullKeys && JSON.stringify(fullKeys) !== JSON.stringify(canonical)) {
        failures.push(`shard ${index} disagrees on the unsplit inventory`);
    }
    if (actualIsValid) executed.push(...actual.tests.map(test => `${test.file}\0${test.title}`));
}
if (new Set(executed).size !== executed.length) failures.push("executed shard inventories overlap");
if (canonical && JSON.stringify([...executed].sort()) !== JSON.stringify(canonical)) {
    failures.push("joined executed identities do not equal the unsplit wrapper selection");
}
if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log(`Verified ${canonical.length} native tests across ${total} non-overlapping shards.`);
