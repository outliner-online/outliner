import fs from "fs";
import { spawnSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test } from "vitest";

/** @feature ENV-4b7e2c91
 *  Title   : CI runs the server mocha suite
 *  Source  : docs/dev-features/env-ci-server-mocha-suite-4b7e2c91.yaml
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const read = (...segments: string[]) => fs.readFileSync(path.join(repoRoot, ...segments), "utf-8");

test("a dedicated workflow runs the server suite", () => {
    const workflow = read(".github", "workflows", "ci-test-server.yml");

    expect(workflow).toMatch(/workflow_call:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/uses: \.\/\.github\/actions\/setup-test-env/);
    expect(workflow).toMatch(/matrix:\s+shard: \[1, 2\]/);
    expect(workflow).toMatch(/SERVER_TEST_SHARD="\$\{\{ matrix\.shard \}\}\/2"/);
    expect(workflow).toMatch(/verify-server-test-shards\.mjs downloaded-server-tests\/server-test-results 2/);
    expect(workflow).toMatch(/name: server-test\n/);
    expect(workflow).toMatch(/Summarise failures/);
    expect(workflow).toMatch(/upload-artifact/);
});

test("server shards retain exact selection and native failure propagation", { timeout: 30_000 }, () => {
    const result = spawnSync("python3", [
        "-m",
        "unittest",
        "scripts.tests.test_server_test_boundary.ServerExecutionBoundaryTest.test_shards_cover_unsplit_native_inventory_and_propagate_failures",
        "-v",
    ], { cwd: repoRoot, encoding: "utf8" });

    expect(result.stdout + result.stderr).toContain("OK");
    expect(result.status).toBe(0);
});

test("the CI entry workflow calls the server test workflow", () => {
    const ci = read(".github", "workflows", "ci.yml");

    expect(ci).toMatch(/uses: \.\/\.github\/workflows\/ci-test-server\.yml/);
});

test("the server test runner pins yjs to the server's node_modules", () => {
    const runner = read("scripts", "run-server-test-command.sh");

    expect(runner).toMatch(/--loader \.\/tests\/loaders\/pin-server-deps\.mjs/);

    // shared/node_modules is symlinked to the client, so without this pin
    // server/src and the co-compiled shared/src load two Yjs instances.
    const loader = read("server", "tests", "loaders", "pin-server-deps.mjs");
    expect(loader).toMatch(/PINNED_SPECIFIERS = new Set\(\["yjs"\]\)/);
});
