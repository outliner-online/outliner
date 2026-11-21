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
const unavailableRunner = path.join(repoRoot, "scripts", "tests", "run-bounded-unavailable-case.sh");

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

function writeDockerStub(directory: string): string {
    const stub = path.join(directory, "docker-stub.sh");
    fs.writeFileSync(stub, `#!/usr/bin/env bash
set -euo pipefail
control=\${4%%:*}
image=\$5
if [[ \$image == late ]]; then
    sleep 2
    touch "\$control/ready"
    while [[ ! -e \$control/start ]]; do sleep 0.1; done
    echo INSTALLER_ADMITTED
    exit 1
fi
sleep 0.6
touch "\$control/ready"
while [[ ! -e \$control/start ]]; do sleep 0.1; done
set +e
timeout --signal=TERM --kill-after=0.3 0.4 bash -c "trap '' TERM; sleep 5"
status=\$?
set -e
echo "INSTALLER_EXIT_STATUS=\$status"
exit "\$status"
`);
    fs.chmodSync(stub, 0o755);
    return stub;
}

test("the host wrapper preserves delayed startup and the full inner allowance", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-unavailable-runner-"));
    const logPath = path.join(directory, "run.log");
    const dockerStub = writeDockerStub(directory);
    const startedAt = Date.now();
    try {
        let status: number | undefined;
        try {
            execFileSync(unavailableRunner, ["1", "1", "1", logPath, "within"], {
                env: { ...process.env, DOCKER_BIN: dockerStub },
                stdio: "ignore",
                timeout: 5000,
            });
        } catch (error) {
            status = (error as { status?: number; }).status;
        }
        expect(status).toBeGreaterThan(0);
        expect(status).not.toBe(124);
        // Startup (0.6s), the inner timeout (0.4s), and its kill grace (0.3s)
        // must all elapse; a pass-only early exit would not prove the bounds compose.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1200);
        expect(fs.readFileSync(logPath, "utf8")).toMatch(/INSTALLER_EXIT_STATUS=[1-9][0-9]*/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("the host wrapper rejects late launch before installer admission", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apt-unavailable-runner-"));
    const logPath = path.join(directory, "run.log");
    const dockerStub = writeDockerStub(directory);
    try {
        let status: number | undefined;
        try {
            execFileSync(unavailableRunner, ["1", "1", "1", logPath, "late"], {
                env: { ...process.env, DOCKER_BIN: dockerStub },
                stdio: "ignore",
                timeout: 5000,
            });
        } catch (error) {
            status = (error as { status?: number; }).status;
        }
        expect(status).toBe(124);
        const log = fs.readFileSync(logPath, "utf8");
        expect(log).toContain("launch exceeded its 1-second allowance before installer admission");
        expect(log).not.toContain("INSTALLER_ADMITTED");
        expect(log).not.toContain("INSTALLER_EXIT_STATUS");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
