import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import YAML from "yaml";

/** @feature ENV-6017e2e0
 *  Title: Exact-ID artifact round-trip recovery
 *  Source: docs/dev-features/env-artifact-roundtrip-exact-id-recovery-6017e2e0.yaml
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-e2e.yml"), "utf8"));
const job = workflow.jobs["artifact-roundtrip"];

function step(name: string): Record<string, any> {
    const result = job.steps.find((candidate: Record<string, any>) => candidate.name === name);
    expect(result, `artifact-roundtrip must retain ${name}`).toBeDefined();
    return result;
}

test("a transient miss retries only the finalized artifact identity", () => {
    expect(job["timeout-minutes"]).toBe(5);
    expect(job.permissions).toEqual({ contents: "read" });

    const upload = step("Upload representative E2E evidence");
    expect(upload.id).toBe("representative-upload");
    expect(upload.with.archive).toBe(true);
    expect(upload.with["retention-days"]).toBe(1);

    const firstDownload = step("Download representative E2E evidence");
    const retryDownload = step("Retry representative E2E evidence by exact identity");
    const exactId = "${{ steps.representative-upload.outputs.artifact-id }}";
    expect(firstDownload.id).toBe("representative-download");
    expect(firstDownload["continue-on-error"]).toBe(true);
    expect(firstDownload.with).toEqual({ "artifact-ids": exactId, path: "artifact-roundtrip/primary-download" });
    expect(retryDownload.if).toBe("steps.representative-download.outcome == 'failure'");
    expect(retryDownload.with).toEqual({ "artifact-ids": exactId, path: "artifact-roundtrip/retry-download" });
    expect(retryDownload.with.name).toBeUndefined();
    expect(retryDownload.with["run-id"]).toBeUndefined();
    expect(step("Wait for exact artifact visibility").if).toBe(retryDownload.if);
});

test("successful recovery still uses independent identity and byte-content oracles", () => {
    const identity = step("Record and validate artifact identities");
    expect(identity.run).toContain('test "$EXPECTED_ARTIFACT_ID" != "$WRONG_ARTIFACT_ID"');

    const verification = step("Verify downloaded E2E evidence");
    expect(verification.run).toContain(
        'scripts/ci/verify-artifact-roundtrip.sh artifact-roundtrip/source "$VERIFIED_ARTIFACT_DIRECTORY"',
    );

    const forcedMiss = step("Force a first-lookup failure control");
    expect(forcedMiss.with["artifact-ids"]).toBe("0");
    expect(forcedMiss["continue-on-error"]).toBe(true);
    const forcedRecovery = step("Recover the forced miss by exact positive identity");
    expect(forcedRecovery.if).toBe("steps.forced-first-miss.outcome == 'failure'");
    expect(forcedRecovery.with["artifact-ids"]).toBe("${{ steps.representative-upload.outputs.artifact-id }}");
    expect(forcedRecovery.with.path).not.toBe(forcedMiss.with.path);
    expect(step("Verify forced recovery identity and bytes").run).toContain(
        "artifact-roundtrip/source artifact-roundtrip/forced-recovery",
    );

    const repeatedMiss = step("Force a repeated lookup failure control");
    expect(repeatedMiss.with["artifact-ids"]).toBe("0");
    expect(repeatedMiss.with.path).not.toBe(forcedMiss.with.path);
    expect(step("Confirm repeated lookup failure is non-success").run).toContain(
        'test "$REPEATED_OUTCOME" = failure',
    );

    const unavailable = step("Reject an unavailable artifact");
    expect(unavailable["continue-on-error"]).toBe(true);
    expect(step("Confirm unavailable artifact is non-success").run).toContain(
        'test "$DOWNLOAD_OUTCOME" = failure',
    );

    const negativeContent = step("Confirm wrong, missing, and corrupted evidence are non-success").run;
    for (const rejected of ["wrong-downloaded", "missing-file", "corrupted-file"]) {
        expect(negativeContent).toContain(`artifact-roundtrip/${rejected}`);
    }
});

test("partial leftovers from separate attempts cannot combine into success", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-recovery-leftovers-"));
    const source = path.join(temporaryRoot, "source");
    const primary = path.join(temporaryRoot, "primary");
    const retry = path.join(temporaryRoot, "retry");
    const verifier = path.join(root, "scripts/ci/verify-artifact-roundtrip.sh");

    try {
        for (const directory of [source, primary, retry]) fs.mkdirSync(directory);
        fs.writeFileSync(path.join(source, "execution.json"), '{"status":"passed"}\n');
        fs.writeFileSync(path.join(source, "runtime.log"), "firefox evidence retained\n");
        fs.copyFileSync(path.join(source, "execution.json"), path.join(primary, "execution.json"));
        fs.copyFileSync(path.join(source, "runtime.log"), path.join(retry, "runtime.log"));

        expect(() => execFileSync(verifier, [source, primary])).toThrow();
        expect(() => execFileSync(verifier, [source, retry])).toThrow();
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
