import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test } from "vitest";

/** @feature ENV-6c87a4d2
 *  Title   : Test-container APT acquisition fails closed
 *  Source  : docs/dev-features/env-test-container-apt-fallback-6c87a4d2.yaml
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...parts: string[]) => fs.readFileSync(path.join(repoRoot, ...parts), "utf8");

test("the image uses the bounded installer and CI runs its Docker regression", () => {
    const dockerfile = read(".github", "container", "Dockerfile");
    const workflow = read(".github", "workflows", "build-container.yml");
    const installer = read("scripts", "install-test-container-os-packages.sh");
    const integration = read("scripts", "tests", "test-container-os-packages.integration.sh");
    const verifier = read("scripts", "verify-test-container-os-tools.sh");

    expect(dockerfile).toContain("/usr/local/bin/install-test-container-os-packages");
    expect(installer).toContain("Acquire::Retries=2");
    expect(installer).toContain("APT_ACQUISITION_BUDGET_SECONDS:-180");
    expect(installer).toContain("APT_ACQUISITION_SHUTDOWN_GRACE_SECONDS:-5");
    expect(installer).toContain('timeout --signal=TERM --kill-after="$shutdown_grace_seconds"');
    expect(installer).toContain("dpkg-query");
    expect(workflow).toContain("scripts/tests/test-container-os-packages.integration.sh");
    expect(workflow).toContain("docker run --rm outliner-test-container:ci");
    expect(workflow).toContain("bash /cache/scripts/verify-test-container-os-tools.sh");
    expect(verifier).toContain("netcat-openbsd");
    expect(verifier).toContain("python3-pip");
    expect(verifier).toContain("python3 -m pip --version");
    expect(integration).toContain("dpkg --remove --force-depends");
    expect(integration).toContain("verify-missing-netcat-openbsd");
    expect(integration).toContain("verify-missing-python3-pip");
    expect(integration).toContain("unavailable_outer_watchdog_seconds=45");
    expect(integration).toContain("Dockerfile.fixture");
    expect(integration).toContain("outliner-apt-regression:fixture");
    expect(integration).toContain("negative_case_setup_timeout_seconds=30");
    expect(integration).toContain("NEGATIVE_CASE_PHASE_STARTED");
    expect(integration).toContain("setup_expired");
    expect(integration).toContain("APT::Update::Error-Mode");
    expect(integration).toContain('verify-container-negative-case.sh" "$negative_case"');
});
