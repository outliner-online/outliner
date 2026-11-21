#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const artifactDir = path.resolve(process.argv[2] ?? "unit-artifacts");
const shardCount = Number(process.argv[3] ?? 2);
if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("invalid shard count");
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
if (!runId || !runAttempt) throw new Error("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required");
const clientDir = path.resolve("client");
const vitestBin = process.env.UNIT_VITEST_BIN ?? path.join(clientDir, "node_modules/.bin/vitest");
const configArgs = process.env.UNIT_VITEST_CONFIG ? [`--config=${process.env.UNIT_VITEST_CONFIG}`] : [];

function relativeFile(file) {
    const withoutProject = file.trim().replace(/^\[unit\]\s+/, "");
    return path.isAbsolute(withoutProject) ? path.relative(clientDir, withoutProject) : withoutProject;
}
function expectedIdentities(report) {
    return report.map((test) => `${relativeFile(test.file)} > ${test.name}`);
}
function executedIdentities(report) {
    const identities = [];
    for (const file of report.testResults ?? []) {
        for (const assertion of file.assertionResults ?? []) {
            const names = assertion.ancestorTitles?.length
                ? [...assertion.ancestorTitles, assertion.title]
                : [assertion.fullName ?? assertion.title];
            identities.push([relativeFile(file.name), ...names.filter(Boolean)].join(" > "));
        }
    }
    return identities;
}
function frequency(values) {
    const result = new Map();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
}
function compareIdentities(actual, expected) {
    const actualCounts = frequency(actual);
    const expectedCounts = frequency(expected);
    const differences = [...new Set([...actualCounts.keys(), ...expectedCounts.keys()])]
        .filter((id) => actualCounts.get(id) !== expectedCounts.get(id));
    if (differences.length) {
        throw new Error(
            `executed test identities differ from native selection: ${
                differences.slice(0, 20).map((id) =>
                    `${id} (actual ${actualCounts.get(id) ?? 0}, expected ${expectedCounts.get(id) ?? 0})`
                ).join(", ")
            }`,
        );
    }
}
function mapDefinitions(data) {
    return JSON.stringify({
        path: data.path,
        statementMap: data.statementMap,
        fnMap: data.fnMap,
        branchMap: data.branchMap,
    });
}
function repositoryCoverageInventory() {
    if (process.env.UNIT_COVERAGE_MANIFEST) {
        return JSON.parse(fs.readFileSync(process.env.UNIT_COVERAGE_MANIFEST, "utf8")).map((file) => path.resolve(file))
            .sort();
    }
    const sourceRoot = path.join(clientDir, "src");
    const sourceFiles = fs.readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
    return sourceFiles.filter((file) => /\.(?:js|ts|svelte)$/.test(file))
        .filter((file) => !/\.(?:spec|test)\.(?:js|ts)$/.test(file))
        .filter((file) => !/(?:^|\/)tests\//.test(file))
        // Keep this synchronized with the explicit coverage exclusions in
        // client/vite.config.ts. In particular, generated declarations are
        // part of Vitest's native inventory, and "paraglide" in a route or in
        // the generated `src/paraglide.` directory is not excluded.
        .filter((file) => !/(?:^|\/)lib\/paraglide\//.test(file))
        .filter((file) => !/(?:^|\/)stories\//.test(file))
        .filter((file) =>
            !["service-worker.ts", "vite-env.d.ts", "global.d.ts", "app.d.ts"].includes(
                path.relative(sourceRoot, file),
            )
        )
        .map((file) => path.resolve(file)).sort();
}
function mergeCoverage(target, coverage) {
    for (const [file, data] of Object.entries(coverage)) {
        if (!target[file]) {
            target[file] = structuredClone(data);
            continue;
        }
        for (const key of Object.keys(data.s)) target[file].s[key] = (target[file].s[key] ?? 0) + data.s[key];
        for (const key of Object.keys(data.f)) target[file].f[key] = (target[file].f[key] ?? 0) + data.f[key];
        for (const [key, counts] of Object.entries(data.b)) {
            const previous = target[file].b[key] ?? counts.map(() => 0);
            target[file].b[key] = counts.map((count, index) => (previous[index] ?? 0) + count);
        }
    }
}

const nativeSelectionPath = path.join(os.tmpdir(), `unit-native-selection-${runId}-${runAttempt}.json`);
execFileSync(vitestBin, ["list", ...configArgs, "--project", "unit", "--no-static-parse",
    `--json=${nativeSelectionPath}`], {
    cwd: clientDir,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
});
const expected = expectedIdentities(JSON.parse(fs.readFileSync(nativeSelectionPath, "utf8")));
fs.rmSync(nativeSelectionPath);
if (!expected.length) throw new Error("native unit selection is empty");
const executed = [];
const mergedCoverage = {};
const expectedCoverageFiles = repositoryCoverageInventory();
let expectedCoverageDefinitions;
for (let shard = 1; shard <= shardCount; shard++) {
    const shardDir = path.join(artifactDir, `unit-shard-${shard}-${runId}-${runAttempt}`);
    const reportPath = path.join(shardDir, "unit-evidence", `shard-${shard}.json`);
    const coveragePath = path.join(shardDir, "coverage", `unit-shard-${shard}`, "coverage-final.json");
    if (!fs.existsSync(reportPath)) throw new Error(`missing current-attempt execution report for shard ${shard}`);
    if (!fs.existsSync(coveragePath)) throw new Error(`missing current-attempt coverage for shard ${shard}`);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const identities = executedIdentities(report);
    if (!identities.length) throw new Error(`empty execution report for shard ${shard}`);
    executed.push(...identities);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
    const coverageFiles = Object.keys(coverage).map((file) => path.resolve(file)).sort();
    if (!coverageFiles.length) throw new Error(`empty coverage for shard ${shard}`);
    if (JSON.stringify(coverageFiles) !== JSON.stringify(expectedCoverageFiles)) {
        const missing = expectedCoverageFiles.filter((file) => !coverageFiles.includes(file));
        const extra = coverageFiles.filter((file) => !expectedCoverageFiles.includes(file));
        throw new Error(
            `coverage differs from repository inventory for shard ${shard}; missing=${
                missing.slice(0, 20).join(",")
            } extra=${extra.slice(0, 20).join(",")}`,
        );
    }
    const definitions = Object.fromEntries(
        Object.entries(coverage).map(([file, data]) => [path.resolve(file), mapDefinitions(data)]),
    );
    expectedCoverageDefinitions ??= definitions;
    for (const file of expectedCoverageFiles) {
        if (definitions[file] !== expectedCoverageDefinitions[file]) {
            throw new Error(`coverage map definitions differ for shard ${shard}: ${file}`);
        }
    }
    mergeCoverage(mergedCoverage, coverage);
}
compareIdentities(executed, expected);
if (Object.keys(mergedCoverage).length !== expectedCoverageFiles.length) {
    throw new Error("merged coverage is incomplete");
}
const output = path.resolve("coverage/unit_and_integration/coverage-final.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(mergedCoverage));
console.log(`Verified ${expected.length} executed unit tests and ${expectedCoverageFiles.length} coverage files.`);
