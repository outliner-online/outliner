import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
function realVitestFailureRunner(directory: string) {
    const testFile = path.join(directory, "deliberate-failure.test.js");
    const config = path.join(directory, "vitest.config.js");
    fs.writeFileSync(testFile,
        'import { test, expect } from "vitest"; test("deliberate native failure", () => expect(1).toBe(2));\n');
    fs.writeFileSync(config,
        `export default { test: { root: ${JSON.stringify(directory)}, include: ["*.test.js"], globals: true } };\n`);
    const wrapper = path.join(directory, "real-vitest-wrapper");
    const vitest = path.join(root, "scripts/tests/node_modules/.bin/vitest");
    executable(wrapper, `#!/bin/bash
args=()
skip=false
for arg in "$@"; do
  if [[ "$skip" == true ]]; then skip=false; continue; fi
  case "$arg" in
    --project) skip=true ;;
    --coverage|--coverage.reportsDirectory=*|--shard=*) ;;
    --reporter=github-actions|--reporter=dot) ;;
    *) args+=("$arg") ;;
  esac
done
exec ${JSON.stringify(vitest)} "\${args[@]}" --config=${JSON.stringify(config)}
`);
    return { wrapper, config, vitest };
}

function artifactFixture(directory: string, run = "100", attempt = "2") {
    fs.writeFileSync(path.join(directory, "coverage-manifest.json"), JSON.stringify(["/source.ts"]));
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
        fs.writeFileSync(path.join(base, "coverage", `unit-shard-${shard}`, "coverage-final.json"), JSON.stringify({
            "/source.ts": {
                path: "/source.ts",
                statementMap: { [shard === 1 ? 0 : 5]: {} },
                fnMap: {},
                branchMap: {},
                s: { [shard === 1 ? 0 : 5]: 1 },
                f: {},
                b: {},
            },
        }));
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
        const realFailure = realVitestFailureRunner(directory);
        const failed = spawnSync(path.join(root, "scripts/ci/run-unit-tests.sh"), [], {
            cwd: root,
            env: env({
                UNIT_SHARD: "1/2",
                UNIT_VITEST_BIN: realFailure.wrapper,
                UNIT_EVIDENCE_DIR: directory,
                UNIT_COVERAGE_DIR: path.join(directory, "real-coverage"),
            }),
        });
        expect(failed.status).toBe(1);
        expect(
            JSON.parse(fs.readFileSync(path.join(directory, "shard-1.json"), "utf8")).testResults[0].assertionResults[0]
                .status,
        ).toBe("failed");
    });

    test("the real aggregate verifies exact identities and coverage before running base exactly once", () => {
        const directory = temporaryDirectory();
        artifactFixture(directory);
        const vitest = fakeVitest(directory);
        const marker = path.join(directory, "base-ran");
        const base = path.join(directory, "base");
        executable(base, `#!/bin/sh\nprintf ran >> '${marker}'\n`);
        execFileSync(path.join(root, "scripts/ci/finalize-unit-tests.sh"), [], {
            cwd: root,
            env: env({
                UNIT_ARTIFACT_DIR: directory,
                UNIT_VITEST_BIN: vitest,
                UNIT_BASE_RUNNER: base,
                UNIT_COVERAGE_MANIFEST: path.join(directory, "coverage-manifest.json"),
            }),
        });
        expect(fs.readFileSync(marker, "utf8")).toBe("ran");
        expect(
            JSON.parse(
                fs.readFileSync(path.join(root, "coverage/unit_and_integration/coverage-final.json"), "utf8"),
            )["/source.ts"].s[0],
        ).toBe(2);
    });

    test("the aggregate propagates base failure and rejects missing, empty, stale, and duplicate evidence", () => {
        const directory = temporaryDirectory();
        artifactFixture(directory);
        const vitest = fakeVitest(directory);
        const realBaseFailure = realVitestFailureRunner(directory);
        const failingBase = path.join(directory, "base-fails");
        executable(failingBase, `#!/bin/sh
exec ${JSON.stringify(realBaseFailure.vitest)} run --config=${JSON.stringify(realBaseFailure.config)}
`);
        const run = (artifacts: string, extra: Record<string, string> = {}) =>
            spawnSync(
                path.join(root, "scripts/ci/finalize-unit-tests.sh"),
                [],
                {
                    cwd: root,
                    env: env({
                        UNIT_ARTIFACT_DIR: artifacts,
                        UNIT_VITEST_BIN: vitest,
                        UNIT_BASE_RUNNER: failingBase,
                        UNIT_COVERAGE_MANIFEST: path.join(directory, "coverage-manifest.json"),
                        ...extra,
                    }),
                },
            );
        expect(run(directory).status).toBe(1);
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
        const first = path.join(directory, "unit-shard-1-100-2/unit-evidence/shard-1.json");
        fs.copyFileSync(first, path.join(directory, "unit-shard-2-100-2/unit-evidence/shard-2.json"));
        expect(run(directory).stderr.toString()).toContain("executed test identities differ");
    });

    test("workflow retains the stable aggregate and runs base only after both shards", () => {
        const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-unit.yml"), "utf8"));
        expect(fs.readFileSync(path.join(root, "scripts/ci/verify-unit-shards.mjs"), "utf8")).toContain(
            "--no-static-parse",
        );
        expect(workflow.jobs["unit-test"].needs).toBe("unit-shard");
        expect(workflow.jobs["unit-test"].if).toBe("always()");
        expect(workflow.jobs["unit-test"].steps.some((step: any) => step.uses === "./.github/actions/setup-test-env"))
            .toBe(true);
        expect(workflow.jobs["unit-test"].steps.find((step: any) => step.name.includes("Verify")).run)
            .toBe("scripts/ci/finalize-unit-tests.sh");
        expect(JSON.parse(fs.readFileSync(path.join(root, "client/package.json"), "utf8")).scripts["github:test:unit"])
            .toBe("bash ../scripts/ci/run-unit-tests.sh");
    });
});
