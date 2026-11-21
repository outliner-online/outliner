import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

/** @feature ENV-a4c29f1e
 *  Title: Supported GitHub Actions majors
 *  Source: docs/dev-features/env-github-actions-supported-majors-a4c29f1e.yaml
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDirectory = path.join(root, ".github/workflows");
const actionDirectory = path.join(root, ".github/actions");

const supportedMajors: Record<string, number> = {
    "actions/cache": 6,
    "actions/checkout": 7,
    "actions/configure-pages": 6,
    "actions/deploy-pages": 5,
    "actions/download-artifact": 8,
    "actions/setup-java": 6,
    "actions/setup-node": 7,
    "actions/setup-python": 7,
    "actions/upload-artifact": 7,
    "actions/upload-pages-artifact": 5,
    "docker/build-push-action": 7,
    "docker/login-action": 4,
    "docker/metadata-action": 6,
    "docker/setup-buildx-action": 4,
    "getsentry/action-release": 3,
    // Official release audit: google-github-actions/setup-gcloud v3.0.1.
    "google-github-actions/setup-gcloud": 3,
    "peter-evans/create-pull-request": 8,
};

const activeYamlFiles = [
    ...fs.readdirSync(workflowDirectory).filter((file) => /\.ya?ml$/.test(file))
        .map((file) => path.join(workflowDirectory, file)),
    ...fs.readdirSync(actionDirectory, { recursive: true })
        .filter((file) => typeof file === "string" && /(?:^|\/)action\.ya?ml$/.test(file))
        .map((file) => path.join(actionDirectory, file)),
];

function parseWorkflow(name: string): Record<string, any> {
    return YAML.parse(fs.readFileSync(path.join(workflowDirectory, name), "utf8"));
}

function findStep(workflow: Record<string, any>, job: string, name: string): Record<string, any> {
    const step = workflow.jobs[job].steps.find((candidate: Record<string, any>) => candidate.name === name);
    expect(step, `${job} must retain the ${name} step`).toBeDefined();
    return step;
}

function expectMultiFileArtifactArchive(step: Record<string, any>): void {
    expect(step.with.path.trim().split("\n").length, "the regression requires multiple evidence inputs")
        .toBeGreaterThan(1);
    expect(step.with.archive, "upload-artifact v7 requires archive mode for a named multi-file artifact").toBe(true);
}

describe("active external action references", () => {
    test.each(activeYamlFiles.map((file) => path.relative(root, file)))("%s uses the audited stable majors", (file) => {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        expect(() => YAML.parse(source), `${file} must remain valid YAML`).not.toThrow();
        for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*$/gm)) {
            const reference = match[1];
            if (reference.startsWith("./")) continue;

            const versionMatch = /^(.+?)(?:\/(?:restore|save))?@v(\d+)$/.exec(reference);
            expect(versionMatch, `${file}: ${reference} must use an audited major tag`).not.toBeNull();
            const [, action, major] = versionMatch!;
            expect(supportedMajors[action], `${file}: ${action} is missing from the release audit`).toBeDefined();
            expect(Number(major), `${file}: ${reference} is not on the audited stable major`).toBe(
                supportedMajors[action],
            );
        }
    });
});

test("representative PR CI retains its trigger, permissions, guards, and failure propagation", () => {
    const workflow = parseWorkflow("ci.yml");

    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
    expect(workflow.permissions).toEqual({
        actions: "write",
        contents: "write",
        packages: "write",
        "pull-requests": "write",
    });
    expect(workflow.jobs.format.needs).toBe("pr-guards");
    expect(workflow.jobs["unit-test"].needs).toContain("pr-guards");
    expect(workflow.jobs["unit-test"]["continue-on-error"]).toBeUndefined();
});

test("direct-runner fixture uses the authenticated action cache and passes its loaded image to the regression", () => {
    const e2e = parseWorkflow("ci-test-e2e.yml");
    const job = e2e.jobs["direct-runner-os-regression"];
    const mirror = findStep(e2e, "direct-runner-os-regression", "Verify mirror-only control and owned-child cleanup");
    const deadline = findStep(e2e, "direct-runner-os-regression", "Start shared fixture provisioning deadline");
    const build = findStep(e2e, "direct-runner-os-regression", "Build cached direct-runner fixture");
    const regression = findStep(e2e, "direct-runner-os-regression", "Exercise real isolated package acquisition");

    expect(build.uses).toBe("./.github/actions/bounded-buildx");
    expect(build.with).toMatchObject({
        context: ".",
        file: "scripts/tests/fixtures/direct-runner-os/Dockerfile",
        load: true,
        tags: "outliner-direct-os-regression:ci",
        "cache-from": "type=gha,scope=direct-runner-os-fixture-v1",
        "cache-to": "type=gha,mode=max,scope=direct-runner-os-fixture-v1",
    });
    expect(job.steps.indexOf(mirror)).toBeLessThan(job.steps.indexOf(deadline));
    expect(job.steps.indexOf(deadline)).toBeLessThan(job.steps.indexOf(build));
    expect(deadline.run).toContain("time.monotonic_ns() + 900_000_000_000");
    expect(deadline.run).toContain("DIRECT_RUNNER_OS_PROVISIONING_DEADLINE_NS");
    expect(regression.env.DIRECT_RUNNER_OS_PREBUILT_IMAGE).toBe(build.with.tags);
    expect(regression["continue-on-error"]).toBeUndefined();
});

test("a delayed hosted build consumes the same monotonic deadline as container provisioning", () => {
    const e2e = parseWorkflow("ci-test-e2e.yml");
    const job = e2e.jobs["direct-runner-os-provisioning-deadline"];
    const deadline = findStep(
        e2e,
        "direct-runner-os-provisioning-deadline",
        "Start controlled shared provisioning deadline",
    );
    const build = findStep(e2e, "direct-runner-os-provisioning-deadline", "Build deliberately delayed fixture");
    const acquisition = findStep(
        e2e,
        "direct-runner-os-provisioning-deadline",
        "Acquisition must stay blocked after deadline expiry",
    );
    const verification = findStep(
        e2e,
        "direct-runner-os-provisioning-deadline",
        "Verify deadline failure blocked every scenario",
    );

    expect(job.steps.indexOf(deadline)).toBeLessThan(job.steps.indexOf(build));
    expect(deadline.run).toContain("time.monotonic_ns() + 5_000_000_000");
    expect(deadline.run).toContain("observe-build.py");
    expect(build.uses).toBe("./.github/actions/bounded-buildx");
    expect(build.with.context).toBe("scripts/tests/fixtures/direct-runner-os/deadline-control");
    expect(deadline.run).toContain('--network "container:$builder_container"');
    expect(build.with.network).toBe("host");
    expect(build.with["no-cache"]).toBe(true);
    expect(build["continue-on-error"]).toBe(true);
    expect(acquisition.if).toBe("steps.delayed-build.outcome == 'success'");
    expect(acquisition.run).toContain("unexpected-scenario-launch");
    expect(acquisition.run).toContain("env-direct-runner-os-acquisition-5921b0ad.spec.ts");
    expect(verification.env.BUILD_OUTCOME).toBe("${{ steps.delayed-build.outcome }}");
    expect(verification.run).toContain('test "$BUILD_OUTCOME" = failure');
    expect(verification.run).toContain('evidence.outcome !== "deadline"');
    expect(verification.run).toContain('"event": "client-closed"');
    expect(verification.run).toContain('"event": "natural-completion"');
    expect(verification.run).toContain("test ! -e job_logs/unexpected-scenario-launch");
});

test("a hosted fixture failure cannot enter the scenario acquisition caller", () => {
    const e2e = parseWorkflow("ci-test-e2e.yml");
    const job = e2e.jobs["direct-runner-os-provisioning-failure"];
    const build = findStep(e2e, "direct-runner-os-provisioning-failure", "Exercise failing fixture provisioning");
    const acquisition = findStep(e2e, "direct-runner-os-provisioning-failure", "Acquisition must stay blocked");
    const verification = findStep(
        e2e,
        "direct-runner-os-provisioning-failure",
        "Verify provisioning failure propagation",
    );

    expect(job["continue-on-error"]).toBeUndefined();
    expect(build).toMatchObject({
        uses: "./.github/actions/bounded-buildx",
        "continue-on-error": true,
        with: {
            context: "scripts/tests/fixtures/direct-runner-os/failure-control",
            load: true,
            tags: "outliner-direct-os-regression:failure-control",
        },
    });
    expect(acquisition.if).toBe("steps.fixture-build.outcome == 'success'");
    expect(acquisition.run).toContain("unexpected-scenario-launch");
    expect(acquisition.run).toContain("env-direct-runner-os-acquisition-5921b0ad.spec.ts");
    expect(verification.if).toBe("always()");
    expect(verification.env.BUILD_OUTCOME).toBe("${{ steps.fixture-build.outcome }}");
    expect(verification.run).toContain('test "$BUILD_OUTCOME" = failure');
    expect(verification.run).toContain("test ! -e job_logs/unexpected-scenario-launch");
});

test("bounded hosted fixture entry point terminates its owned process group at the shared deadline", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-buildx-"));
    const bin = path.join(temporary, "bin");
    const evidence = path.join(temporary, "evidence.json");
    const terminated = path.join(temporary, "terminated");
    const scenario = path.join(temporary, "scenario-launched");
    const argumentsFile = path.join(temporary, "arguments");
    fs.mkdirSync(bin);
    fs.writeFileSync(
        path.join(bin, "docker"),
        `#!/usr/bin/env bash
printf '%s\n' "$@" > "${argumentsFile}"
trap 'printf terminated > "${terminated}"; exit 143' TERM
sleep 30 &
wait
printf launched > "${scenario}"
`,
        { mode: 0o755 },
    );

    const started = process.hrtime.bigint();
    let status = 0;
    try {
        execFileSync(process.execPath, [path.join(actionDirectory, "bounded-buildx/index.mjs")], {
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                DIRECT_RUNNER_OS_PROVISIONING_DEADLINE_NS: (started + 250_000_000n).toString(),
                INPUT_CONTEXT: ".",
                INPUT_TAGS: "bounded-control:test",
                INPUT_LOAD: "true",
                "INPUT_CACHE-FROM": "type=gha,scope=bounded-control",
                "INPUT_CACHE-TO": "type=gha,mode=max,scope=bounded-control",
                "INPUT_EVIDENCE-FILE": evidence,
                "INPUT_CLEANUP-GRACE-SECONDS": "1",
            },
            stdio: "pipe",
        });
    } catch (error) {
        status = (error as { status?: number; }).status ?? 0;
    }

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(status).not.toBe(0);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(fs.readFileSync(terminated, "utf8")).toBe("terminated");
    expect(fs.readFileSync(argumentsFile, "utf8")).toContain("type=gha,scope=bounded-control");
    expect(fs.readFileSync(argumentsFile, "utf8")).toContain("type=gha,mode=max,scope=bounded-control");
    expect(fs.existsSync(scenario), "a terminated fixture build must never launch a scenario").toBe(false);
    expect(JSON.parse(fs.readFileSync(evidence, "utf8"))).toMatchObject({
        outcome: "deadline",
        buildStarted: true,
        terminated: true,
    });
});

test("artifact and Pages deployment producers retain their consumer-facing contracts", () => {
    const e2e = parseWorkflow("ci-test-e2e.yml");
    const artifact = findStep(e2e, "e2e-test", "Upload Logs & Artifacts");
    expect(artifact.if).toBe(
        "steps.tests.outputs.startup_verified == 'true' && (failure() || startsWith(matrix.project, 'firefox-') || startsWith(matrix.project, 'new-2-') || startsWith(matrix.project, 'new-3') || matrix.project == 'tables-1' || matrix.project == 'utils')",
    );
    expect(artifact.with.name).toBe(
        "e2e-artifacts-${{ env.E2E_BROWSER }}-${{ matrix.project }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expectMultiFileArtifactArchive(artifact);

    const incompatibleArtifact = structuredClone(artifact);
    incompatibleArtifact.with.archive = false;
    expect(() => expectMultiFileArtifactArchive(incompatibleArtifact)).toThrowError(
        "upload-artifact v7 requires archive mode for a named multi-file artifact",
    );

    const roundtripUpload = findStep(e2e, "artifact-roundtrip", "Upload representative E2E evidence");
    const roundtripDownload = findStep(e2e, "artifact-roundtrip", "Download representative E2E evidence");
    const wrongUpload = findStep(e2e, "artifact-roundtrip", "Upload wrong-artifact control");
    expectMultiFileArtifactArchive(roundtripUpload);
    expect(roundtripUpload.with.name).toBe(
        artifact.with.name
            .replace("${{ env.E2E_BROWSER }}", "firefox")
            .replace("${{ matrix.project }}", "artifact-roundtrip"),
    );
    expect(roundtripUpload.id).toBe("representative-upload");
    expect(roundtripDownload.with["artifact-ids"]).toBe(
        "${{ steps.representative-upload.outputs.artifact-id }}",
    );
    expect(roundtripDownload.with.name).toBeUndefined();
    expect(wrongUpload.id).toBe("wrong-upload");
    expectMultiFileArtifactArchive(wrongUpload);
    expect(findStep(e2e, "artifact-roundtrip", "Verify downloaded E2E evidence").run).toContain(
        "scripts/ci/verify-artifact-roundtrip.sh artifact-roundtrip/source artifact-roundtrip/downloaded",
    );
    expect(findStep(e2e, "artifact-roundtrip", "Reject an unavailable artifact")["continue-on-error"]).toBe(true);
    expect(findStep(e2e, "artifact-roundtrip", "Confirm unavailable artifact is non-success").run).toContain(
        'test "$DOWNLOAD_OUTCOME" = failure',
    );
    const negativeControls = findStep(
        e2e,
        "artifact-roundtrip",
        "Confirm wrong, missing, and corrupted evidence are non-success",
    ).run;
    expect(negativeControls).toContain("artifact-roundtrip/wrong-downloaded");
    expect(negativeControls).toContain("artifact-roundtrip/missing-file");
    expect(negativeControls).toContain("artifact-roundtrip/corrupted-file");

    const pages = parseWorkflow("docs-deploy.yml");
    expect(findStep(pages, "build", "Upload artifact").with.path).toBe("docs/.vitepress/dist");
    expect(pages.jobs.deploy.needs).toBe("build");
    expect(findStep(pages, "deploy", "Deploy to GitHub Pages").id).toBe("deployment");
});

test("artifact round-trip verifier independently rejects missing and changed evidence", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-roundtrip-"));
    const source = path.join(temporaryRoot, "source");
    const downloaded = path.join(temporaryRoot, "downloaded");
    const verifier = path.join(root, "scripts/ci/verify-artifact-roundtrip.sh");

    try {
        fs.mkdirSync(source);
        fs.mkdirSync(downloaded);
        for (
            const [name, content] of [
                ["execution.json", '{"status":"passed"}\n'],
                ["runtime.log", "firefox evidence retained\n"],
            ]
        ) {
            fs.writeFileSync(path.join(source, name), content);
            fs.writeFileSync(path.join(downloaded, name), content);
        }

        expect(() => execFileSync(verifier, [source, downloaded])).not.toThrow();

        fs.rmSync(path.join(downloaded, "runtime.log"));
        expect(() => execFileSync(verifier, [source, downloaded])).toThrow();

        fs.writeFileSync(path.join(downloaded, "runtime.log"), "corrupted evidence\n");
        expect(() => execFileSync(verifier, [source, downloaded])).toThrow();
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test("production deployment remains success-gated and Sentry upgrades do not mutate build output", () => {
    const workflow = parseWorkflow("deploy.yml");

    expect(workflow.on.workflow_run).toEqual({ branches: ["main"], types: ["completed"], workflows: ["CI"] });
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
    for (
        const name of [
            "Create Sentry release (Client)",
            "Create Sentry release (Server)",
            "Create Sentry release (Functions)",
        ]
    ) {
        const step = findStep(workflow, "deploy", name);
        expect(step.uses).toBe("getsentry/action-release@v3");
        expect(step.with.inject).toBe(false);
    }
    expect(findStep(workflow, "deploy", "Deploy to Firebase").if).toBe("github.actor != 'dependabot[bot]'");
});
