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

function expectUnavailableEvidence(confirmation: Record<string, any>): void {
    expect(confirmation.if).toBe("always()");
    expect(confirmation.env).toMatchObject({
        DOWNLOAD_OUTCOME: "${{ steps.unavailable-download.outcome }}",
        GH_TOKEN: "${{ github.token }}",
    });
    expect(confirmation.run).toContain('test "$DOWNLOAD_OUTCOME" = failure');
    expect(confirmation.run).toContain("repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts");
    expect(confirmation.run).toContain("! grep -Fxq '0'");
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
    expectAuthenticatedIdentity(step(job, "Reject an unavailable artifact"), "0");
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

    const nameOnly = structuredClone(positive);
    delete nameOnly.with["artifact-ids"];
    nameOnly.with.name = "e2e-artifacts";
    expect(() => expectAuthenticatedIdentity(nameOnly, "${{ steps.representative-upload.outputs.artifact-id }}"))
        .toThrow();
});

test("unavailable control requires both download failure and authenticated absence evidence", () => {
    const confirmation = step(artifactJob(), "Confirm unavailable artifact is non-success");
    expectUnavailableEvidence(confirmation);

    const authFailureAccepted = structuredClone(confirmation);
    delete authFailureAccepted.env.GH_TOKEN;
    expect(() => expectUnavailableEvidence(authFailureAccepted)).toThrow();

    const downloadFailureAlone = structuredClone(confirmation);
    downloadFailureAlone.run = 'test "$DOWNLOAD_OUTCOME" = failure';
    expect(() => expectUnavailableEvidence(downloadFailureAlone)).toThrow();
});
