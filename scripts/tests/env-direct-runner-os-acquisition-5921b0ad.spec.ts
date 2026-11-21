/** @feature ENV-5921b0ad
 * Source: docs/dev-features/env-direct-runner-os-acquisition-5921b0ad.yaml
 * Real APT/dpkg/browser tests in disposable Ubuntu containers; no command mocks.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const image = `outliner-direct-os-regression:${process.pid}`;
const owner = randomUUID().slice(0, 8);
const scenarios = ["success", "unavailable", "slow", "missing", "nonroot-success", "nonroot-playwright-slow"];
const preparedContainers = new Set<string>();
const containerName = (scenario: string) => `outliner-direct-os-${process.pid}-${owner}-${scenario}`;
let buildContext: string | undefined;
const output = (result: ReturnType<typeof spawnSync>) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

beforeAll(() => {
    const docker = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 10000 });
    expect(docker.error, "Docker control is required; this suite must never silently skip").toBeUndefined();
    expect(docker.status, output(docker)).toBe(0);
    buildContext = mkdtempSync(join(tmpdir(), "direct-runner-os-"));
    mkdirSync(join(buildContext, "client"));
    copyFileSync(join(root, "client/package-lock.json"), join(buildContext, "client/package-lock.json"));
    copyFileSync(join(root, "scripts/tests/fixtures/direct-runner-os/Dockerfile"), join(buildContext, "Dockerfile"));
    // Honor a managed environment's trusted CA without disabling TLS checks.
    const ca = process.env.NODE_EXTRA_CA_CERTS;
    const trust = ca ? ["--secret", `id=environment-ca,src=${ca}`] : [];
    // Image construction and fresh, unstarted containers share the original
    // provisioning budget. No acquisition runs before the per-case clock.
    const provisioningDeadline = performance.now() + 900000;
    const remainingProvisioning = () => {
        const remaining = Math.floor(provisioningDeadline - performance.now());
        if (remaining <= 0) throw new Error("Fixture provisioning deadline exceeded");
        return remaining;
    };
    const build = spawnSync("bash", [
        join(root, "scripts/tests/fixtures/direct-runner-os/build-fixture.sh"),
        image,
        buildContext,
        ...trust,
    ], {
        cwd: root,
        encoding: "utf8",
        timeout: remainingProvisioning(),
        maxBuffer: 20 * 1024 * 1024,
    });
    console.log(output(build));
    expect(build.error).toBeUndefined();
    expect(build.status).toBe(0);
    expect(output(build)).toContain(
        process.env.DIRECT_RUNNER_OS_CACHE_SCOPE ? "fixture-build cache=gha" : "fixture-build cache=local-default",
    );
    for (const scenario of scenarios) {
        const name = containerName(scenario);
        preparedContainers.add(name); // Reclaim our uniquely named partial create on failure, too.
        const created = spawnSync("docker", [
            "create",
            "--rm",
            "--name",
            name,
            "-v",
            `${join(root, "scripts")}:/source/scripts:ro`,
            image,
            "bash",
            "/source/scripts/tests/fixtures/direct-runner-os/run-case.sh",
            scenario,
        ], { encoding: "utf8", timeout: remainingProvisioning(), maxBuffer: 1024 * 1024 });
        expect(created.error, output(created)).toBeUndefined();
        expect(created.status, output(created)).toBe(0);
    }
}, 920000);

afterAll(() => {
    let cleanup: ReturnType<typeof spawnSync> | undefined;
    try {
        if (preparedContainers.size) {
            cleanup = spawnSync("docker", ["rm", "-f", ...preparedContainers], { timeout: 10000 });
        }
    } finally {
        try {
            if (buildContext) rmSync(buildContext, { recursive: true, force: true });
        } finally {
            spawnSync("docker", ["image", "rm", "-f", image], { encoding: "utf8", timeout: 30000 });
        }
    }
    if (cleanup) {
        expect(cleanup.error, "Unstarted fixture cleanup must complete").toBeUndefined();
        expect(cleanup.status).toBe(0);
    }
});

function run(scenario: string, limit: number) {
    const name = containerName(scenario);
    expect(preparedContainers.delete(name), "Each case requires its own fresh, unused container").toBe(true);
    const started = performance.now();
    const result = spawnSync("docker", ["start", "--attach", name], {
        encoding: "utf8",
        timeout: limit,
        maxBuffer: 20 * 1024 * 1024,
    });
    const elapsed = performance.now() - started;
    console.log(`${scenario}: elapsed=${elapsed}ms exit=${result.status}\n${output(result)}`);
    if (result.error || result.status !== 0) spawnSync("docker", ["rm", "-f", name], { timeout: 10000 });
    expect(result.error, "Independent outer harness must not terminate the acquisition").toBeUndefined();
    expect(result.signal).toBeNull();
    return { result, elapsed, log: output(result) };
}

test("required packages are acquired and an independent browser actually executes", () => {
    const { result, elapsed, log } = run("success", 650000);
    expect(result.status).toBe(0);
    expect(elapsed).toBeLessThan(610000);
    expect(log).toContain("stage=ready exit=0");
    expect(log).toContain("INDEPENDENT_BROWSER_EXECUTED");
}, 660000);

for (const scenario of ["unavailable", "slow"]) {
    test(`${scenario} sources fail inside the aggregate deadline with APT evidence`, () => {
        const { result, elapsed, log } = run(scenario, 30000);
        expect(result.status).not.toBeNull();
        expect(result.status).not.toBe(0);
        expect(elapsed).toBeLessThan(18000); // 15s aggregate + container scheduling overhead
        expect(log).toContain("stage=apt-update exit=");
        expect(log).toContain("127.0.0.1");
        expect(log).toContain("Required OS package is not installed:");
        expect(log).not.toContain("stage=ready");
        if (scenario === "slow") {
            expect(elapsed).toBeGreaterThanOrEqual(9500);
            expect([124, 137]).toContain(result.status);
            expect(log).toContain("SLOW_SOURCE_REQUEST");
        } else {
            expect(log).toMatch(/Failed to fetch|Could not connect|Connection refused/);
        }
    }, 40000);
}

test("a real warm browser cache cannot hide a removed required dependency", () => {
    const { result, elapsed, log } = run("missing", 650000);
    expect(result.status).toBe(1);
    expect(elapsed).toBeLessThan(610000);
    const negativeLog = log.split("MISSING_DEPENDENCY_CONTROL")[1];
    expect(negativeLog).toContain("REAL_DOWNLOAD_ONLY_COMPLETED");
    expect(negativeLog).toContain("Required OS package is not installed: lsof");
    expect(negativeLog).not.toContain("stage=ready");
}, 660000);

test("a nonroot runner retains its own cache and executes the locked Firefox", () => {
    const { result, elapsed, log } = run("nonroot-success", 650000);
    expect(result.status).toBe(0);
    expect(elapsed).toBeLessThan(610000);
    expect(log).toContain("stage=ready exit=0");
    expect(log).toContain("INDEPENDENT_NONROOT_FIREFOX_EXECUTED");
}, 660000);

test("nonroot Playwright acquisition closes its tee pipeline and root acquisition within the budget", () => {
    const { result, log } = run("nonroot-playwright-slow", 850000);
    expect(result.status).toBe(0);
    const record = JSON.parse(log.split("NONROOT_PIPELINE_OUTCOME ")[1].split("\n")[0]);
    expect([124, 137]).toContain(record.exit);
    expect(record.elapsedMs).toBeLessThan(33000);
    expect(record.activeAcquisition).toEqual([]);
}, 860000);
