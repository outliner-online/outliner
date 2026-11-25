import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
const unavailableVerifier = path.join(root, "scripts/ci/verify-unavailable-artifact-response.sh");

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
    expect(control.run).toContain("gh api --include");
    expect(control.run).toContain(
        "repos/$GITHUB_REPOSITORY/actions/artifacts/$UNAVAILABLE_ARTIFACT_ID/zip",
    );
    expect(control.run).toContain("verify-unavailable-artifact-response.sh");
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

    const verify = (requestExit: string, httpStatus: string, artifactId = "0"): number =>
        spawnSync(unavailableVerifier, [requestExit, httpStatus, artifactId], { encoding: "utf8" }).status ?? -1;

    expect(verify("1", "404"), "an authenticated not-found response is the required control").toBe(0);
    expect(verify("1", "401"), "authentication failure must not satisfy the control").not.toBe(0);
    expect(verify("1", ""), "a transport failure has no authoritative HTTP response").not.toBe(0);
    expect(verify("0", ""), "an unexpectedly successful download must not satisfy the control").not.toBe(0);
    expect(verify("invalid", "404"), "an ambiguous request result must not satisfy the control").not.toBe(0);
    expect(verify("1", "404", "not-an-id"), "a 404 for an invalid identity must not satisfy the control").not.toBe(0);
});
