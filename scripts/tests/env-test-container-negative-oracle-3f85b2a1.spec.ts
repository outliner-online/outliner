import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test } from "vitest";

/** @feature ENV-6c87a4d2
 *  Title   : Test-container APT acquisition fails closed
 *  Source  : docs/dev-features/env-test-container-apt-fallback-6c87a4d2.yaml
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(repoRoot, "scripts", "tests", "verify-container-negative-case.sh");
const boundedBuild = path.join(repoRoot, "scripts", "tests", "run-bounded-docker-build.sh");

const unavailableEvidence = `
APT fetch attempt: primary host 127.0.0.1:18081
APT fetch failure: primary host 127.0.0.1:18081
Err:1 http://127.0.0.1:18081 jammy InRelease
APT fetch attempt: fallback host 127.0.0.1:18082
APT fetch failure: fallback host 127.0.0.1:18082
Err:2 http://127.0.0.1:18082 jammy InRelease
INSTALLER_EXIT_STATUS=1
UNAVAILABLE_WATCHDOG_EXIT_STATUS=1
`;

function verify(status: number, log: string): { ok: boolean; output: string; } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-negative-oracle-"));
    const logPath = path.join(directory, "build.log");
    fs.writeFileSync(logPath, log);
    try {
        const output = execFileSync(verifier, ["unavailable", String(status), logPath], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, output };
    } catch (error) {
        const result = error as { stderr?: Buffer | string; };
        return { ok: false, output: String(result.stderr ?? "") };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test("accepts endpoint-specific failures and the installer's nonzero status", () => {
    expect(verify(1, unavailableEvidence).ok).toBe(true);
});

test("rejects outer-watchdog termination", () => {
    const result = verify(124, unavailableEvidence);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out before unavailable reported its own failure");
});

test("rejects an in-container watchdog result despite complete endpoint evidence", () => {
    const result = verify(1, unavailableEvidence
        .replace("INSTALLER_EXIT_STATUS=1", "INSTALLER_EXIT_STATUS=124")
        .replace("UNAVAILABLE_WATCHDOG_EXIT_STATUS=1", "UNAVAILABLE_WATCHDOG_EXIT_STATUS=124"));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ended at its in-container watchdog instead of the installer");
});

test("rejects a skipped installer and missing installer failure evidence", () => {
    const skipped = verify(1, "docker setup failed before RUN\n");
    expect(skipped.ok).toBe(false);
    expect(skipped.output).toContain("lacks a nonzero installer-reported status");

    const missingEndpointFailure = verify(
        1,
        "INSTALLER_EXIT_STATUS=1\nUNAVAILABLE_WATCHDOG_EXIT_STATUS=1\n",
    );
    expect(missingEndpointFailure.ok).toBe(false);
    expect(missingEndpointFailure.output).toContain("lacks endpoint evidence");
});

test("rejects package-install failure after both endpoint indexes were fetched", () => {
    const indexesSucceeded = `
APT fetch attempt: primary host 127.0.0.1:18081
Get:1 http://127.0.0.1:18081 jammy InRelease
APT fetch succeeded: primary host 127.0.0.1:18081
APT package installation failure: primary host 127.0.0.1:18081
APT fetch attempt: fallback host 127.0.0.1:18082
Get:2 http://127.0.0.1:18082 jammy InRelease
APT fetch succeeded: fallback host 127.0.0.1:18082
APT package installation failure: fallback host 127.0.0.1:18082
INSTALLER_EXIT_STATUS=1
UNAVAILABLE_WATCHDOG_EXIT_STATUS=1
`;
    const result = verify(1, indexesSucceeded);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("lacks endpoint evidence");
});

test("rejects an unexpectedly successful image build", () => {
    const result = verify(0, unavailableEvidence);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unexpectedly built successfully");
});

test("the build watcher ignores a Dockerfile heading until execution emits the marker", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-build-watch-"));
    const logPath = path.join(directory, "build.log");
    try {
        let status: number | undefined;
        try {
            execFileSync(boundedBuild, ["0.3", "0.1", logPath, "bash", "-ceu", `
echo "RUN printf 'NEGATIVE_CASE_PHASE_%s\\n' STARTED"
trap '' TERM
sleep 5
`], { stdio: "ignore", timeout: 3000 });
        } catch (error) {
            status = (error as { status?: number; }).status;
        }
        expect(status).toBe(124);
        expect(fs.existsSync(`${logPath}.setup-expired`)).toBe(true);
        expect(fs.existsSync(`${logPath}.case-expired`)).toBe(false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("the actual build watcher bounds a TERM-ignoring full case phase and reaps it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-build-watch-"));
    const logPath = path.join(directory, "build.log");
    try {
        let status: number | undefined;
        try {
            execFileSync(boundedBuild, ["1", "0.2", logPath, "bash", "-ceu", `
sleep 0.2
echo NEGATIVE_CASE_PHASE_STARTED
trap '' TERM
sleep 5
`], { stdio: "ignore", timeout: 3000 });
        } catch (error) {
            status = (error as { status?: number; }).status;
        }
        expect(status).toBe(124);
        expect(fs.existsSync(`${logPath}.setup-expired`)).toBe(false);
        expect(fs.existsSync(`${logPath}.case-expired`)).toBe(true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("a case marker near the setup deadline wins the transition arbitration", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-build-watch-"));
    const logPath = path.join(directory, "build.log");
    try {
        execFileSync(boundedBuild, ["0.4", "1", logPath, "bash", "-ceu", `
sleep 0.35
echo NEGATIVE_CASE_PHASE_STARTED
sleep 0.15
echo INSTALLER_EXIT_STATUS=1
exit 1
`], { stdio: "ignore", timeout: 3000 });
    } catch (error) {
        expect((error as { status?: number; }).status).toBe(1);
    }
    expect(fs.readFileSync(logPath, "utf8")).toContain("INSTALLER_EXIT_STATUS=1");
    expect(fs.existsSync(`${logPath}.setup-expired`)).toBe(false);
    expect(fs.existsSync(`${logPath}.case-expired`)).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
});

test("the actual build watcher allows the inner timeout and shutdown grace to finish", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-build-watch-"));
    const logPath = path.join(directory, "build.log");
    try {
        let status: number | undefined;
        try {
            execFileSync(boundedBuild, ["1", "2", logPath, "bash", "-ceu", `
echo NEGATIVE_CASE_PHASE_STARTED
set +e
timeout --signal=TERM --kill-after=0.2 0.3 bash -c "trap '' TERM; sleep 5"
status=$?
set -e
echo "INSTALLER_EXIT_STATUS=$status"
exit "$status"
`], { stdio: "ignore", timeout: 3000 });
        } catch (error) {
            status = (error as { status?: number; }).status;
        }
        expect(status).not.toBe(124);
        expect(status).toBeGreaterThan(0);
        expect(fs.readFileSync(logPath, "utf8")).toMatch(/INSTALLER_EXIT_STATUS=[1-9][0-9]*/);
        expect(fs.existsSync(`${logPath}.setup-expired`)).toBe(false);
        expect(fs.existsSync(`${logPath}.case-expired`)).toBe(false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
