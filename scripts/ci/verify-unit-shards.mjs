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
            if (["pending", "skipped", "todo", "disabled"].includes(assertion.status)) continue;
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
function validateCoverageMaps(coverage) {
    for (const [file, data] of Object.entries(coverage)) {
        for (const [mapName, counterName] of [["statementMap", "s"], ["fnMap", "f"], ["branchMap", "b"]]) {
            const definitions = Object.keys(data[mapName]).sort();
            const counters = Object.keys(data[counterName]).sort();
            if (JSON.stringify(definitions) !== JSON.stringify(counters)) {
                throw new Error(`coverage ${mapName} does not match ${counterName} counters: ${file}`);
            }
        }
    }
}
function coverageEntryCount(data) {
    return Object.keys(data.statementMap).length + Object.keys(data.fnMap).length + Object.keys(data.branchMap).length;
}
function canonicalDefinitions(map) {
    return [...new Set(Object.values(map).map((definition) => JSON.stringify(definition)))].sort();
}
function coverageDefinitionSignatures(map) {
    const withoutColumns = (value) => {
        if (Array.isArray(value)) return value.map(withoutColumns);
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value)
                    .filter(([key]) => key !== "column")
                    .map(([key, child]) => [key, withoutColumns(child)]),
            );
        }
        return value;
    };
    return [...new Set(Object.values(map).map((definition) => JSON.stringify(withoutColumns(definition))))].sort();
}
function validateCoverageSchema(coverage, schema, shard) {
    for (const [file, expected] of Object.entries(schema)) {
        if (!coverage[file]) throw new Error(`coverage is missing schema file in shard ${shard}: ${file}`);
        for (const mapName of ["statementMap", "fnMap", "branchMap"]) {
            if (JSON.stringify(coverage[file][mapName]) !== JSON.stringify(expected[mapName])) {
                throw new Error(`coverage ${mapName} differs from runner schema for shard ${shard}: ${file}`);
            }
        }
    }
}
function mergeCoverageReports(reports) {
    const result = {};
    for (const coverage of reports) {
        for (const [file, data] of Object.entries(coverage)) {
            const target = result[file] ??= {
                ...data,
                statementMap: {},
                fnMap: {},
                branchMap: {},
                s: {},
                f: {},
                b: {},
            };
            for (const [mapName, counterName] of [["statementMap", "s"], ["fnMap", "f"], ["branchMap", "b"]]) {
                const definitions = new Map(Object.entries(target[mapName]).map(([key, definition]) => [
                    JSON.stringify(definition),
                    key,
                ]));
                for (const [key, definition] of Object.entries(data[mapName])) {
                    const serialized = JSON.stringify(definition);
                    let targetKey = definitions.get(serialized);
                    if (targetKey === undefined) {
                        targetKey = String(definitions.size);
                        definitions.set(serialized, targetKey);
                        target[mapName][targetKey] = definition;
                        target[counterName][targetKey] = counterName === "b" ? [] : 0;
                    }
                    if (counterName === "b") {
                        const counts = data[counterName][key];
                        target[counterName][targetKey] = counts.map((count, index) =>
                            count + (target[counterName][targetKey][index] ?? 0)
                        );
                    } else {
                        target[counterName][targetKey] += data[counterName][key];
                    }
                }
            }
        }
    }
    return result;
}
function validateCompleteCoverageMaps(coverage, baseline) {
    for (const [file, expected] of Object.entries(baseline)) {
        if (coverageEntryCount(expected) === 0) continue;
        if (!coverage[file]) throw new Error(`merged coverage is missing executable file: ${file}`);
        for (const mapName of ["statementMap", "fnMap", "branchMap"]) {
            // Svelte's source-map columns can differ depending on whether a
            // module is transformed during discovery or test execution. Match
            // definitions by their stable source lines and structure, while
            // the current-attempt runner schemas above validate exact maps.
            const mergedSignatures = new Set(coverageDefinitionSignatures(coverage[file][mapName]));
            const missingSignatures = coverageDefinitionSignatures(expected[mapName])
                .filter((definition) => !mergedSignatures.has(definition));
            if (missingSignatures.length) {
                throw new Error(`merged coverage ${mapName} is missing native selection definitions: ${file}`);
            }
        }
    }
}
function nativeCoverageBaseline(testFile) {
    if (process.env.UNIT_COVERAGE_BASELINE) {
        return JSON.parse(fs.readFileSync(process.env.UNIT_COVERAGE_BASELINE, "utf8"));
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `unit-coverage-baseline-${runId}-${runAttempt}-`));
    execFileSync(vitestBin, ["run", testFile, ...configArgs, "--project", "unit", "--coverage",
        "--coverage.reporter=json", `--coverage.reportsDirectory=${directory}`], {
        cwd: clientDir,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "test" },
    });
    const baselinePath = path.join(directory, "coverage-final.json");
    if (!fs.existsSync(baselinePath)) throw new Error("native coverage baseline was not produced");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    fs.rmSync(directory, { recursive: true });
    return baseline;
}
const nativeSelectionPath = path.join(os.tmpdir(), `unit-native-selection-${runId}-${runAttempt}.json`);
if (process.env.UNIT_SELECTION_BASELINE) {
    fs.copyFileSync(process.env.UNIT_SELECTION_BASELINE, nativeSelectionPath);
} else {
    execFileSync(vitestBin, ["list", ...configArgs, "--project", "unit", "--no-static-parse",
        `--json=${nativeSelectionPath}`], {
        cwd: clientDir,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "test" },
    });
}
const nativeSelection = JSON.parse(fs.readFileSync(nativeSelectionPath, "utf8"));
const expected = expectedIdentities(nativeSelection);
fs.rmSync(nativeSelectionPath);
if (!expected.length) throw new Error("native unit selection is empty");
const executed = [];
const coverageReports = [];
const expectedCoverageFiles = repositoryCoverageInventory();
const baselineSelection = nativeSelection.find((test) => relativeFile(test.file) === "src/utils/typeGuards.test.ts")
    ?? nativeSelection[0];
const coverageBaseline = nativeCoverageBaseline(relativeFile(baselineSelection.file));
validateCoverageMaps(coverageBaseline);
let nativeCoverageFiles;
for (let shard = 1; shard <= shardCount; shard++) {
    const shardDir = path.join(artifactDir, `unit-shard-${shard}-${runId}-${runAttempt}`);
    const reportPath = path.join(shardDir, "unit-evidence", `shard-${shard}.json`);
    const coveragePath = path.join(shardDir, "coverage", `unit-shard-${shard}`, "coverage-final.json");
    const schemaPath = path.join(shardDir, "unit-evidence", `coverage-schema-${shard}.json`);
    if (!fs.existsSync(reportPath)) throw new Error(`missing current-attempt execution report for shard ${shard}`);
    if (!fs.existsSync(coveragePath)) throw new Error(`missing current-attempt coverage for shard ${shard}`);
    if (!fs.existsSync(schemaPath)) throw new Error(`missing current-attempt coverage schema for shard ${shard}`);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const identities = executedIdentities(report);
    if (!identities.length) throw new Error(`empty execution report for shard ${shard}`);
    executed.push(...identities);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const coverageFiles = Object.keys(coverage).map((file) => path.resolve(file)).sort();
    if (!coverageFiles.length) throw new Error(`empty coverage for shard ${shard}`);
    const missing = expectedCoverageFiles.filter((file) => !coverageFiles.includes(file));
    if (missing.length) {
        throw new Error(
            `coverage differs from repository inventory for shard ${shard}; missing=${missing.slice(0, 20).join(",")}`,
        );
    }
    // V8 can additionally report virtual/generated sources from source maps
    // that have no on-disk repository path. Accept those native entries, but
    // require every shard to report the exact same set and map definitions.
    nativeCoverageFiles ??= coverageFiles;
    if (JSON.stringify(coverageFiles) !== JSON.stringify(nativeCoverageFiles)) {
        throw new Error(`native coverage file set differs for shard ${shard}`);
    }
    validateCoverageMaps(coverage);
    validateCoverageSchema(coverage, schema, shard);
    coverageReports.push(coverage);
}
compareIdentities(executed, expected);
const mergedCoverage = mergeCoverageReports(coverageReports);
if (Object.keys(mergedCoverage).length !== nativeCoverageFiles.length) {
    throw new Error("merged coverage is incomplete");
}
validateCompleteCoverageMaps(mergedCoverage, coverageBaseline);
const output = path.resolve("coverage/unit_and_integration/coverage-final.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(mergedCoverage));
console.log(`Verified ${expected.length} executed unit tests and ${expectedCoverageFiles.length} coverage files.`);
