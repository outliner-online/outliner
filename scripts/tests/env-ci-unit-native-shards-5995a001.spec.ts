import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const unitWorkflow = () => YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-unit.yml"), "utf8"));
const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true })));
function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unit-shards-"));
    temporaryDirectories.push(directory);
    return directory;
}
function executable(file: string, source: string) {
    fs.writeFileSync(file, source, { mode: 0o755 });
}
function fakeVitest(directory: string) {
    const file = path.join(directory, "vitest");
    executable(file, `#!/bin/bash
set -euo pipefail
if [[ "\${1}" == list ]]; then
  for arg in "$@"; do [[ "$arg" == --json=* ]] && output="\${arg#*=}"; done
  printf '[{"file":"%s/src/a.test.ts","name":"suite > first"},{"file":"%s/src/b.test.ts","name":"suite > second"}]' "$PWD" "$PWD" > "$output"
  exit 0
fi
[[ "\${FAKE_UNIT_FAILURE:-}" != true ]] || exit 23
for arg in "$@"; do
  [[ "$arg" == --shard=* ]] && shard="\${arg#*=}"
  [[ "$arg" == --outputFile.json=* ]] && report="\${arg#*=}"
  [[ "$arg" == --coverage.reportsDirectory=* ]] && coverage="\${arg#*=}"
done
index="\${shard%/*}"
mkdir -p "$(dirname "$report")" "$coverage"
name="$PWD/src/$([[ "$index" == 1 ]] && echo a || echo b).test.ts"
title="$([[ "$index" == 1 ]] && echo first || echo second)"
printf '{"testResults":[{"name":"%s","assertionResults":[{"ancestorTitles":["suite"],"title":"%s","status":"passed"}]}]}' "$name" "$title" > "$report"
printf '{"/source.ts":{"path":"/source.ts","statementMap":{"0":{}},"fnMap":{},"branchMap":{},"s":{"0":1},"f":{},"b":{}}}' > "$coverage/coverage-final.json"
`);
    return file;
}
function isolatedCheckout(directory: string, failures: { unit?: boolean; base?: boolean; } = {}) {
    const checkout = path.join(directory, "checkout");
    const client = path.join(checkout, "client");
    fs.mkdirSync(path.join(checkout, "scripts", "ci"), { recursive: true });
    fs.mkdirSync(path.join(client, "src"), { recursive: true });
    for (const script of [
        "run-unit-tests.sh",
        "finalize-unit-tests.sh",
        "verify-unit-shards.mjs",
        "write-unit-coverage-schema.mjs",
    ]) {
        fs.copyFileSync(path.join(root, "scripts", "ci", script), path.join(checkout, "scripts", "ci", script));
    }
    fs.symlinkSync(path.join(root, "client", "node_modules"), path.join(client, "node_modules"), "dir");
    const productionScripts = JSON.parse(fs.readFileSync(path.join(root, "client", "package.json"), "utf8")).scripts;
    fs.writeFileSync(path.join(client, "package.json"), JSON.stringify({
        type: "module",
        scripts: {
            "github:test:unit": productionScripts["github:test:unit"],
            "test:base": productionScripts["test:base"],
        },
    }));
    fs.writeFileSync(
        path.join(client, "src", "covered-source.js"),
        "export const coveredValue = 1;\nexport function coveredFunction() { return coveredValue; }\n",
    );
    for (const file of ["first.test.js", "second.test.js"]) {
        fs.writeFileSync(
            path.join(client, "src", file),
            `import { test, expect } from "vitest"; import { coveredFunction } from "./covered-source.js"; test(${
                JSON.stringify(file)
            }, () => expect(coveredFunction()).toBe(${failures.unit ? 2 : 1}));\n`,
        );
    }
    fs.writeFileSync(
        path.join(client, "vite.config.ts"),
        'export default { test: { projects: [{ test: { name: "unit", include: ["src/*.test.js"], coverage: { enabled: true, provider: "v8", reporter: ["json"], include: ["src/covered-source.js"] } } }] } };\n',
    );
    fs.writeFileSync(
        path.join(client, "base.test.js"),
        `import { test, expect } from "vitest"; test("base package entry", () => { console.log("BASE PACKAGE ENTRY"); expect(1).toBe(${
            failures.base ? 2 : 1
        }); });\n`,
    );
    fs.writeFileSync(
        path.join(client, "vitest.base.config.ts"),
        'export default { test: { include: ["base.test.js"] } };\n',
    );
    return { checkout, client };
}
function runStableWorkflow(isolated: ReturnType<typeof isolatedCheckout>) {
    const artifacts = path.join(isolated.checkout, "unit-artifacts");
    const shardRuns = [1, 2].map((shard) => {
        const result = spawnSync("npm", ["run", "github:test:unit"], {
            cwd: isolated.client,
            env: env({ UNIT_SHARD: `${shard}/2` }),
        });
        if (result.status === 0) {
            const shardDirectory = path.join(artifacts, `unit-shard-${shard}-100-2`);
            fs.mkdirSync(path.join(shardDirectory, "unit-evidence"), { recursive: true });
            fs.mkdirSync(path.join(shardDirectory, "coverage", `unit-shard-${shard}`), { recursive: true });
            fs.copyFileSync(
                path.join(isolated.checkout, "unit-evidence", `shard-${shard}.json`),
                path.join(shardDirectory, "unit-evidence", `shard-${shard}.json`),
            );
            fs.copyFileSync(
                path.join(isolated.checkout, "unit-evidence", `coverage-schema-${shard}.json`),
                path.join(shardDirectory, "unit-evidence", `coverage-schema-${shard}.json`),
            );
            fs.copyFileSync(
                path.join(isolated.checkout, "coverage", `unit-shard-${shard}`, "coverage-final.json"),
                path.join(shardDirectory, "coverage", `unit-shard-${shard}`, "coverage-final.json"),
            );
        }
        return result;
    });
    const workflow = unitWorkflow();
    const reject = workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Reject"));
    const shardResult = shardRuns.every((result) => result.status === 0) ? "success" : "failure";
    const rejection = spawnSync("bash", ["-c", reject.run], {
        cwd: isolated.checkout,
        env: { ...process.env, SHARD_RESULT: shardResult },
    });
    if (rejection.status !== 0) return { artifacts, result: rejection, shardRuns };
    const stableCommand = workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Verify")).run;
    const result = spawnSync("bash", ["-c", stableCommand], {
        cwd: isolated.checkout,
        env: env({ UNIT_ARTIFACT_DIR: artifacts, UNIT_BASE_DIR: path.join(root, "client") }),
    });
    return { artifacts, result, shardRuns };
}
function basePackage(directory: string, failing = true) {
    const baseDirectory = path.join(directory, "base-package");
    fs.mkdirSync(baseDirectory);
    fs.symlinkSync(path.join(root, "client/node_modules"), path.join(baseDirectory, "node_modules"), "dir");
    fs.writeFileSync(path.join(baseDirectory, "package.json"), JSON.stringify({
        scripts: { "test:base": "vitest run --config vitest.base.config.ts" },
    }));
    fs.writeFileSync(path.join(baseDirectory, "deliberate-base-failure.test.js"),
        `import { test, expect } from "vitest"; test("deliberate base-path ${
            failing ? "failure" : "success"
        }", () => expect(1).toBe(${failing ? 2 : 1}));\n`);
    fs.writeFileSync(path.join(baseDirectory, "vitest.base.config.ts"),
        `export default { test: { root: ${JSON.stringify(baseDirectory)}, include: ["*.test.js"] } };\n`);
    return baseDirectory;
}

function artifactFixture(directory: string, run = "100", attempt = "2") {
    fs.writeFileSync(path.join(directory, "coverage-manifest.json"), JSON.stringify(["/source.ts", "/types.d.ts"]));
    fs.writeFileSync(path.join(directory, "selection.json"), JSON.stringify([
        { file: path.join(root, "client", "src", "a.test.ts"), name: "suite > first" },
        { file: path.join(root, "client", "src", "b.test.ts"), name: "suite > second" },
    ]));
    fs.writeFileSync(path.join(directory, "coverage-baseline.json"), JSON.stringify({
        "/source.ts": {
            path: "/source.ts",
            statementMap: {
                0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
                5: { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } },
            },
            fnMap: {},
            branchMap: {},
            s: { 0: 0, 5: 0 },
            f: {},
            b: {},
        },
        "/types.d.ts": { path: "/types.d.ts", statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} },
    }));
    for (const shard of [1, 2]) {
        const base = path.join(directory, `unit-shard-${shard}-${run}-${attempt}`);
        fs.mkdirSync(path.join(base, "unit-evidence"), { recursive: true });
        fs.mkdirSync(path.join(base, "coverage", `unit-shard-${shard}`), { recursive: true });
        const letter = shard === 1 ? "a" : "b";
        const title = shard === 1 ? "first" : "second";
        fs.writeFileSync(path.join(base, "unit-evidence", `shard-${shard}.json`), JSON.stringify({
            testResults: [{
                name: path.join(root, "client", "src", `${letter}.test.ts`),
                assertionResults: [{ ancestorTitles: ["suite"], title, status: "passed" }],
            }],
        }));
        const coverage = {
            "/source.ts": {
                path: "/source.ts",
                statementMap: {
                    0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
                    5: { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } },
                    ...(shard === 1
                        ? { 9: { start: { line: 3, column: 0 }, end: { line: 3, column: 1 } } }
                        : {}),
                },
                fnMap: {},
                branchMap: {},
                s: { 0: shard === 1 ? 1 : 0, 5: shard === 2 ? 1 : 0, ...(shard === 1 ? { 9: 1 } : {}) },
                f: {},
                b: {},
            },
            "/types.d.ts": {
                path: "/types.d.ts",
                statementMap: {},
                fnMap: {},
                branchMap: {},
                s: {},
                f: {},
                b: {},
            },
        };
        fs.writeFileSync(
            path.join(base, "coverage", `unit-shard-${shard}`, "coverage-final.json"),
            JSON.stringify(coverage),
        );
        fs.writeFileSync(
            path.join(base, "unit-evidence", `coverage-schema-${shard}.json`),
            JSON.stringify(Object.fromEntries(Object.entries(coverage).map(([file, data]) => [file, {
                statementMap: data.statementMap,
                fnMap: data.fnMap,
                branchMap: data.branchMap,
            }]))),
        );
    }
}
const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
    ...extra,
});

describe("unit CI native shard orchestration", () => {
    test("the real shard runner writes execution and coverage evidence and propagates unit failure", () => {
        const directory = temporaryDirectory();
        const vitest = fakeVitest(directory);
        execFileSync(path.join(root, "scripts/ci/run-unit-tests.sh"), [], {
            cwd: root,
            env: env({
                UNIT_SHARD: "1/2",
                UNIT_VITEST_BIN: vitest,
                UNIT_EVIDENCE_DIR: directory,
                UNIT_COVERAGE_DIR: path.join(directory, "coverage"),
            }),
        });
        expect(fs.statSync(path.join(directory, "shard-1.json")).size).toBeGreaterThan(0);
        const failingCheckout = isolatedCheckout(path.join(directory, "native-failure"), { unit: true });
        const failedWorkflow = runStableWorkflow(failingCheckout);
        expect(failedWorkflow.result.status).toBe(1);
        expect(failedWorkflow.shardRuns.some((result) => result.status !== 0)).toBe(true);
        expect(
            failedWorkflow.shardRuns.some((result) =>
                `${result.stdout}\n${result.stderr}`.includes("expected 1 to be 2")
            ),
        )
            .toBe(true);
    });

    test("the real aggregate verifies exact identities and coverage before running base exactly once", () => {
        const directory = temporaryDirectory();
        artifactFixture(directory);
        const vitest = fakeVitest(directory);
        const marker = path.join(directory, "base-ran");
        const base = path.join(directory, "base");
        executable(base, `#!/bin/sh\nprintf ran >> '${marker}'\nprintf 'BASE OK\\n'\n`);
        execFileSync(path.join(root, "scripts/ci/finalize-unit-tests.sh"), [], {
            cwd: root,
            env: env({
                UNIT_ARTIFACT_DIR: directory,
                UNIT_VITEST_BIN: vitest,
                UNIT_BASE_RUNNER: base,
                UNIT_COVERAGE_MANIFEST: path.join(directory, "coverage-manifest.json"),
                UNIT_COVERAGE_BASELINE: path.join(directory, "coverage-baseline.json"),
            }),
        });
        expect(fs.readFileSync(marker, "utf8")).toBe("ran");
        expect(fs.readFileSync(path.join(root, "job_logs/base-test.log"), "utf8")).toContain("BASE OK");
        const mergedCoverage = JSON.parse(
            fs.readFileSync(path.join(root, "coverage/unit_and_integration/coverage-final.json"), "utf8"),
        );
        expect(Object.keys(mergedCoverage).sort()).toEqual(["/source.ts", "/types.d.ts"]);
        expect(mergedCoverage["/source.ts"]).toMatchObject({
            statementMap: {
                0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
            },
            s: { 0: 1 },
        });
        // Shard-local Svelte instrumentation can add a definition that the full
        // native run does not emit. It is preserved without weakening the rule
        // that every definition from the independent native baseline exists.
        expect(Object.keys(mergedCoverage["/source.ts"].statementMap)).toHaveLength(3);
        expect(mergedCoverage["/types.d.ts"]).toMatchObject({
            statementMap: {},
            fnMap: {},
            branchMap: {},
            s: {},
            f: {},
            b: {},
        });
    });

    test("the shipped stable-check command verifies a real native sharded selection", () => {
        const directory = temporaryDirectory();
        const isolated = isolatedCheckout(directory);
        const successfulWorkflow = runStableWorkflow(isolated);
        expect(
            successfulWorkflow.result.status,
            `${successfulWorkflow.result.stdout}\n${successfulWorkflow.result.stderr}`,
        ).toBe(0);
        expect(successfulWorkflow.shardRuns.every((result) => result.status === 0)).toBe(true);
        const nativeCoverageDirectory = path.join(isolated.checkout, "native-coverage");
        const nativeCoverageRun = spawnSync(
            path.join(isolated.client, "node_modules/.bin/vitest"),
            [
                "run",
                "--project",
                "unit",
                "--coverage",
                `--coverage.reportsDirectory=${nativeCoverageDirectory}`,
            ],
            { cwd: isolated.client, env: env() },
        );
        expect(nativeCoverageRun.status).toBe(0);
        const nativeCoverage = JSON.parse(
            fs.readFileSync(path.join(nativeCoverageDirectory, "coverage-final.json"), "utf8"),
        );
        const mergedCoverage = JSON.parse(
            fs.readFileSync(
                path.join(isolated.checkout, "coverage/unit_and_integration/coverage-final.json"),
                "utf8",
            ),
        );
        const coveredSource = nativeCoverage[path.join(isolated.client, "src/covered-source.js")];
        expect(
            Object.keys(coveredSource.statementMap).length
                + Object.keys(coveredSource.fnMap).length
                + Object.keys(coveredSource.branchMap).length,
        ).toBeGreaterThan(1);
        expect(mergedCoverage).toEqual(nativeCoverage);
        expect(fs.readFileSync(path.join(isolated.checkout, "job_logs/base-test.log"), "utf8")).toContain(
            "passed",
        );
        const nativeFailure = path.join(root, "client", "src", "tests", "deliberate-native-failure.base-spec.ts");
        fs.writeFileSync(
            nativeFailure,
            'import { expect, test } from "vitest"; test("BASE PACKAGE ENTRY", () => expect(1).toBe(2));\n',
        );
        try {
            const failingBaseCheckout = isolatedCheckout(temporaryDirectory());
            const failedWorkflow = runStableWorkflow(failingBaseCheckout);
            expect(failedWorkflow.result.status).toBe(1);
            const baseFailureLog = fs.readFileSync(
                path.join(failingBaseCheckout.checkout, "job_logs/base-test.log"),
                "utf8",
            );
            expect(baseFailureLog).toContain("BASE PACKAGE ENTRY");
            expect(baseFailureLog).toContain("expected 1 to be 2");
        } finally {
            fs.rmSync(nativeFailure);
        }
    }, 120_000);

    test("the package unit entry remains usable without shard orchestration", () => {
        const isolated = isolatedCheckout(temporaryDirectory());
        const result = spawnSync("npm", ["run", "github:test:unit"], {
            cwd: isolated.client,
            env: env({ UNIT_SHARD: "" }),
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("> test:base");

        const unitFailure = isolatedCheckout(temporaryDirectory(), { unit: true });
        const failedUnit = spawnSync("npm", ["run", "github:test:unit"], {
            cwd: unitFailure.client,
            env: env({ UNIT_SHARD: "" }),
        });
        expect(failedUnit.status).toBe(1);
        expect(`${failedUnit.stdout}\n${failedUnit.stderr}`).not.toContain("> test:base");

        const baseFailure = isolatedCheckout(temporaryDirectory(), { base: true });
        const failedBase = spawnSync("npm", ["run", "github:test:unit"], {
            cwd: baseFailure.client,
            env: env({ UNIT_SHARD: "" }),
        });
        expect(failedBase.status).toBe(1);
        expect(`${failedBase.stdout}\n${failedBase.stderr}`).toContain("BASE PACKAGE ENTRY");
    });

    test("the aggregate propagates base failure and rejects missing, empty, stale, and duplicate evidence", () => {
        const directory = temporaryDirectory();
        artifactFixture(directory);
        const vitest = fakeVitest(directory);
        const failingBase = basePackage(directory);
        const stableCommand =
            unitWorkflow().jobs["unit-test"].steps.find((step: any) => step.name.includes("Verify")).run;
        const run = (artifacts: string, extra: Record<string, string> = {}) =>
            spawnSync(
                "bash",
                ["-c", stableCommand],
                {
                    cwd: root,
                    env: env({
                        UNIT_ARTIFACT_DIR: artifacts,
                        UNIT_VITEST_BIN: vitest,
                        UNIT_BASE_RUNNER: "",
                        UNIT_BASE_DIR: failingBase,
                        UNIT_COVERAGE_MANIFEST: path.join(directory, "coverage-manifest.json"),
                        UNIT_COVERAGE_BASELINE: path.join(directory, "coverage-baseline.json"),
                        UNIT_SELECTION_BASELINE: path.join(directory, "selection.json"),
                        ...extra,
                    }),
                },
            );
        const baseFailure = run(directory);
        expect(baseFailure.status).toBe(1);
        expect(fs.readFileSync(path.join(root, "job_logs/base-test.log"), "utf8")).toContain(
            "deliberate base-path failure",
        );
        fs.rmSync(path.join(directory, "unit-shard-2-100-2/unit-evidence/shard-2.json"));
        expect(run(directory).stderr.toString()).toContain("missing current-attempt execution report");
        artifactFixture(directory);
        fs.writeFileSync(path.join(directory, "unit-shard-2-100-2/unit-evidence/shard-2.json"), "{}");
        expect(run(directory).stderr.toString()).toContain("empty execution report");
        artifactFixture(directory);
        expect(run(directory, { GITHUB_RUN_ID: "stale" }).stderr.toString()).toContain("missing current-attempt");
        artifactFixture(directory);
        const coverage = path.join(directory, "unit-shard-2-100-2/coverage/unit-shard-2/coverage-final.json");
        fs.writeFileSync(coverage, "{}");
        expect(run(directory).stderr.toString()).toContain("empty coverage");
        artifactFixture(directory);
        fs.rmSync(coverage);
        expect(run(directory).stderr.toString()).toContain("missing current-attempt coverage");
        artifactFixture(directory);
        fs.writeFileSync(path.join(directory, "coverage-manifest.json"), JSON.stringify(["/source.ts", "/omitted.ts"]));
        expect(run(directory).stderr.toString()).toContain("coverage differs from repository inventory");
        artifactFixture(directory);
        for (const shard of [1, 2]) {
            const shardCoverage = path.join(
                directory,
                `unit-shard-${shard}-100-2/coverage/unit-shard-${shard}/coverage-final.json`,
            );
            const data = JSON.parse(fs.readFileSync(shardCoverage, "utf8"));
            data["/source.ts"] = {
                path: "/source.ts",
                statementMap: {},
                fnMap: {},
                branchMap: {},
                s: {},
                f: {},
                b: {},
            };
            fs.writeFileSync(shardCoverage, JSON.stringify(data));
        }
        expect(run(directory).stderr.toString()).toContain("coverage statementMap differs from runner schema");
        artifactFixture(directory);
        for (const shard of [1, 2]) {
            const shardCoverage = path.join(
                directory,
                `unit-shard-${shard}-100-2/coverage/unit-shard-${shard}/coverage-final.json`,
            );
            const data = JSON.parse(fs.readFileSync(shardCoverage, "utf8"));
            delete data["/source.ts"].statementMap[5];
            delete data["/source.ts"].s[5];
            fs.writeFileSync(shardCoverage, JSON.stringify(data));
            const schemaPath = path.join(
                directory,
                `unit-shard-${shard}-100-2/unit-evidence/coverage-schema-${shard}.json`,
            );
            const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
            delete schema["/source.ts"].statementMap[5];
            fs.writeFileSync(schemaPath, JSON.stringify(schema));
        }
        expect(run(directory).stderr.toString()).toContain(
            "merged coverage statementMap is missing native selection definitions",
        );
        artifactFixture(directory);
        const first = path.join(directory, "unit-shard-1-100-2/unit-evidence/shard-1.json");
        fs.copyFileSync(first, path.join(directory, "unit-shard-2-100-2/unit-evidence/shard-2.json"));
        expect(run(directory).stderr.toString()).toContain("executed test identities differ");
        artifactFixture(directory);
        const skipped = path.join(directory, "unit-shard-2-100-2/unit-evidence/shard-2.json");
        const skippedReport = JSON.parse(fs.readFileSync(skipped, "utf8"));
        skippedReport.testResults[0].assertionResults[0].status = "skipped";
        fs.writeFileSync(skipped, JSON.stringify(skippedReport));
        expect(run(directory).stderr.toString()).toContain("empty execution report for shard 2");
    });

    test("workflow retains the stable aggregate and runs base only after both shards", () => {
        const workflow = unitWorkflow();
        expect(fs.readFileSync(path.join(root, "scripts/ci/verify-unit-shards.mjs"), "utf8")).toContain(
            "--no-static-parse",
        );
        expect(workflow.jobs["unit-test"].needs).toEqual(["unit-shard", "unit-coverage-baseline"]);
        expect(workflow.jobs["unit-test"].if).toBe("always()");
        expect(workflow.jobs["unit-test"]["timeout-minutes"]).toBe(20);
        expect(workflow.jobs["unit-test"].steps.some((step: any) => step.uses === "./.github/actions/setup-test-env"))
            .toBe(false);
        const verify = workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Verify"));
        expect(verify.run).toBe("scripts/ci/finalize-unit-tests.sh");
        const baselineDownload = workflow.jobs["unit-test"].steps.find((step: any) =>
            step.name === "Download current-attempt native coverage baseline"
        );
        expect(baselineDownload.with.path).toBe(".");
        expect(verify.env.UNIT_COVERAGE_BASELINE).toBe("coverage/unit-baseline/coverage-final.json");
        expect(verify.env.UNIT_SELECTION_BASELINE).toBe("coverage/unit-baseline/selection.json");
        expect(
            workflow.jobs["unit-coverage-baseline"].steps.find((step: any) =>
                step.name === "Generate native unit coverage schema"
            ).run,
        ).toContain("--project unit --coverage --passWithNoTests");
        expect(
            workflow.jobs["unit-test"].steps.find((step: any) => step.name === "Restore unit dependencies")
                .run,
        ).toContain("/cache/client/node_modules");
        expect(
            workflow.jobs["unit-test"].steps.find((step: any) => step.name === "Restore unit dependencies")
                .run,
        ).toContain("shared/node_modules");
        expect(
            workflow.jobs["unit-coverage-baseline"].steps.find((step: any) =>
                step.name === "Record native unit selection"
            ).run,
        ).toContain("vitest list --project unit --no-static-parse");
        const diagnostics = workflow.jobs["unit-test"].steps.find((step: any) => step.name === "Upload logs");
        expect(diagnostics.if).toBe("failure()");
        expect(diagnostics.with.name).toBe("unit-test-logs");
        expect(diagnostics.with.path).toContain("unit-artifacts/**/*.log");
        expect(diagnostics.with.path).toContain("job_logs/");
        const downloadIndex = workflow.jobs["unit-test"].steps.findIndex((step: any) => step.name.includes("Download"));
        const rejectIndex = workflow.jobs["unit-test"].steps.findIndex((step: any) => step.name.includes("Reject"));
        expect(downloadIndex).toBeLessThan(rejectIndex);
        const reject = workflow.jobs["unit-test"].steps[rejectIndex];
        expect(reject.env.SHARD_RESULT).toBe("${{ needs.unit-shard.result }}");
        expect(reject.run).toBe('test "$SHARD_RESULT" = success');
        expect(spawnSync("bash", ["-c", reject.run], { env: { ...process.env, SHARD_RESULT: "failure" } }).status)
            .toBe(1);
        expect(spawnSync("bash", ["-c", reject.run], { env: { ...process.env, SHARD_RESULT: "success" } }).status)
            .toBe(0);
        expect(workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Summarise")).run)
            .toContain("job_logs");
        expect(JSON.parse(fs.readFileSync(path.join(root, "client/package.json"), "utf8")).scripts["github:test:unit"])
            .toBe("bash ../scripts/ci/run-unit-tests.sh");
    });
});
