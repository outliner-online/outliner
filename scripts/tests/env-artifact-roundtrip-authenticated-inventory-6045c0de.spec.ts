import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import YAML from "yaml";

/** @feature ENV-6045c0de
 *  Title: Authenticated artifact round-trip inventory
 *  Source: docs/dev-features/env-artifact-roundtrip-authenticated-inventory-6045c0de.yaml
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ci-test-e2e.yml");
const unavailableControl = path.join(root, "scripts/ci/reject-unavailable-artifact.sh");

function artifactJob(): Record<string, any> {
    return YAML.parse(fs.readFileSync(workflowPath, "utf8")).jobs["artifact-roundtrip"];
}

function step(job: Record<string, any>, name: string): Record<string, any> {
    const result = job.steps.find((candidate: Record<string, any>) => candidate.name === name);
    expect(result, `artifact-roundtrip must retain ${name}`).toBeDefined();
    return result;
}

function expectAuthenticatedIdentity(
    download: Record<string, any>,
    artifactId: string,
): void {
    expect(download.uses).toBe("actions/download-artifact@v8");
    expect(download.with).toMatchObject({
        "artifact-ids": artifactId,
        "github-token": "${{ github.token }}",
        repository: "${{ github.repository }}",
        "run-id": "${{ github.run_id }}",
    });
    expect(download.with.name).toBeUndefined();
}

function expectUnavailableControl(control: Record<string, any>): void {
    expect(control["continue-on-error"]).toBeUndefined();
    expect(control.env).toEqual({
        GH_TOKEN: "${{ github.token }}",
        UNAVAILABLE_ARTIFACT_ID: "0",
    });
    expect(control.run).toContain(
        'scripts/ci/reject-unavailable-artifact.sh \\\n  "$GITHUB_REPOSITORY" "$UNAVAILABLE_ARTIFACT_ID"',
    );
}

test("poll and every download use the same authenticated run inventory and upload identities", () => {
    const job = artifactJob();
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });

    const poll = step(job, "Wait for uploaded artifacts to become discoverable");
    expect(poll.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(poll.run).toContain("repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts");
    expect(poll.run).toContain('grep -Fxq "$EXPECTED_ARTIFACT_ID"');
    expect(poll.run).toContain('grep -Fxq "$WRONG_ARTIFACT_ID"');

    expectAuthenticatedIdentity(
        step(job, "Download representative E2E evidence"),
        "${{ steps.representative-upload.outputs.artifact-id }}",
    );
    expectAuthenticatedIdentity(
        step(job, "Download wrong-artifact control"),
        "${{ steps.wrong-upload.outputs.artifact-id }}",
    );
});

test("regression rejects split lookup paths and substituted artifact identities", () => {
    const positive = step(artifactJob(), "Download representative E2E evidence");

    const defaultInventory = structuredClone(positive);
    delete defaultInventory.with["github-token"];
    expect(() =>
        expectAuthenticatedIdentity(defaultInventory, "${{ steps.representative-upload.outputs.artifact-id }}")
    ).toThrow();

    const otherRun = structuredClone(positive);
    otherRun.with["run-id"] = "1234";
    expect(() => expectAuthenticatedIdentity(otherRun, "${{ steps.representative-upload.outputs.artifact-id }}"))
        .toThrow();

    const otherRepository = structuredClone(positive);
    otherRepository.with.repository = "example/other-repository";
    expect(() => expectAuthenticatedIdentity(otherRepository, "${{ steps.representative-upload.outputs.artifact-id }}"))
        .toThrow();

    const substitutedIdentity = structuredClone(positive);
    substitutedIdentity.with["artifact-ids"] = "${{ steps.wrong-upload.outputs.artifact-id }}";
    expect(() =>
        expectAuthenticatedIdentity(substitutedIdentity, "${{ steps.representative-upload.outputs.artifact-id }}")
    ).toThrow();

    const nameOnly = structuredClone(positive);
    delete nameOnly.with["artifact-ids"];
    nameOnly.with.name = "e2e-artifacts";
    expect(() => expectAuthenticatedIdentity(nameOnly, "${{ steps.representative-upload.outputs.artifact-id }}"))
        .toThrow();
});

test("unavailable control requires both download failure and authenticated absence evidence", () => {
    expectUnavailableControl(step(artifactJob(), "Reject an unavailable artifact"));

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unavailable-artifact-control-"));
    const ghFixture = path.join(fixtureRoot, "gh");
    fs.writeFileSync(
        ghFixture,
        `#!/bin/bash
set -euo pipefail
test "$1" = api
test "$2" = --include
test "$3" = repos/outliner-online/outliner/actions/artifacts/0/zip
case "$PROVIDER_RESULT" in
  not-found) printf 'HTTP/2.0 404 Not Found\\n'; exit 1 ;;
  authentication) printf 'HTTP/2.0 401 Unauthorized\\n'; exit 1 ;;
  network) echo 'connection reset' >&2; exit 1 ;;
  success) printf 'HTTP/2.0 200 OK\\n'; exit 0 ;;
esac
exit 64
`,
        { mode: 0o755 },
    );

    const runControl = (providerResult: string, token = "short-lived-test-token"): number =>
        spawnSync(unavailableControl, ["outliner-online/outliner", "0"], {
            encoding: "utf8",
            env: {
                ...process.env,
                GH_TOKEN: token,
                PATH: `${fixtureRoot}:${process.env.PATH}`,
                PROVIDER_RESULT: providerResult,
            },
        }).status ?? -1;

    try {
        expect(runControl("not-found"), "the production control accepts the exact authenticated 404").toBe(0);
        expect(runControl("authentication"), "the production control rejects authentication failure").not.toBe(0);
        expect(runControl("network"), "the production control rejects transport failure").not.toBe(0);
        expect(runControl("success"), "the production control rejects an unexpected download").not.toBe(0);
        expect(runControl("not-found", ""), "the production control rejects a missing workflow credential").not.toBe(0);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
