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
  printf '%s\\n' '[unit] src/a.test.ts > suite > first' '[unit] src/b.test.ts > suite > second'
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
function artifactFixture(directory: string, run = "100", attempt = "2") {
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
                statementMap: { 0: {} },
                fnMap: {},
                branchMap: {},
                s: { 0: 1 },
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
        const failed = spawnSync(path.join(root, "scripts/ci/run-unit-tests.sh"), [], {
            cwd: root,
            env: env({
                UNIT_SHARD: "1/2",
                UNIT_VITEST_BIN: vitest,
                FAKE_UNIT_FAILURE: "true",
                UNIT_EVIDENCE_DIR: directory,
                UNIT_COVERAGE_DIR: path.join(directory, "coverage"),
            }),
        });
        expect(failed.status).toBe(23);
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
            env: env({ UNIT_ARTIFACT_DIR: directory, UNIT_VITEST_BIN: vitest, UNIT_BASE_RUNNER: base }),
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
        const failingBase = path.join(directory, "base-fails");
        executable(failingBase, "#!/bin/sh\nexit 29\n");
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
                        ...extra,
                    }),
                },
            );
        expect(run(directory).status).toBe(29);
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
        const first = path.join(directory, "unit-shard-1-100-2/unit-evidence/shard-1.json");
        fs.copyFileSync(first, path.join(directory, "unit-shard-2-100-2/unit-evidence/shard-2.json"));
        expect(run(directory).stderr.toString()).toContain("executed test identities differ");
    });

    test("workflow retains the stable aggregate and runs base only after both shards", () => {
        const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-unit.yml"), "utf8"));
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
