/** @feature ENV-8624c6a1 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createCollectionFixture } from "./helpers/firefox-collection-fixture";
import { verifyNew3Partition } from "./helpers/new3-partition";

const root = fileURLToPath(new URL("../../", import.meta.url));
let fixture: ReturnType<typeof createCollectionFixture> | undefined;
afterEach(() => fixture?.dispose());
function probes() {
    fixture = createCollectionFixture();
    for (const name of ["DEL", "diagram", "find", "grid", "homepage", "import"]) {
        fixture.addSpec(`new/${name}-8624c6a1.spec.ts`, ["first case", "second case"]);
    }
    return fixture;
}

describe("ENV-8624c6a1: complete new-3 partition and gate", () => {
    it("collects exactly the former real case set once in the two scheduled halves", () => {
        const result = verifyNew3Partition(path.join(root, "client"),
            path.join(root, ".github/workflows/ci-test-e2e.yml"));
        expect(result.expected).toBeGreaterThan(0);
        expect(result.halves.every(count => count > 0)).toBe(true);
    }, 120_000);

    it("includes uppercase names and every old initial through actual collection", () => {
        const f = probes();
        expect(verifyNew3Partition(f.client, f.workflow)).toEqual({ expected: 12, halves: [6, 6] });
    }, 120_000);

    it("rejects a missing case despite both CI jobs remaining scheduled", () => {
        const f = probes();
        f.mutateProjects('project.name === "new-3b" ? { ...project, grepInvert: /second case/ } : project');
        expect(() => verifyNew3Partition(f.client, f.workflow)).toThrow(/partition mismatch: missing/);
    }, 120_000);

    it("rejects duplicated execution between the halves", () => {
        const f = probes();
        f.mutateProjects('project.name === "new-3b" ? { ...project, testMatch: "**/[defghi]*.spec.ts" } : project');
        expect(() => verifyNew3Partition(f.client, f.workflow)).toThrow(/Duplicate new-3 case/);
    }, 120_000);

    it("rejects an unscheduled half instead of accepting local collection", () => {
        const f = probes();
        f.removeCIProject("new-3b");
        expect(() => verifyNew3Partition(f.client, f.workflow)).toThrow(/schedule new-3b exactly once/);
    }, 120_000);

    it("preserves the old check name and fails its real shell gate on every nonsuccess outcome", () => {
        const document = parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-e2e.yml"), "utf8"));
        const matrix = document.jobs["e2e-test"];
        expect(matrix["timeout-minutes"]).toBe(45);
        expect(matrix.strategy["fail-fast"]).toBe(false);
        const gate = document.jobs["new-3-complete"];
        expect(gate.name).toBe("e2e-test (new-3)");
        expect(gate.needs).toBe("e2e-test");
        expect(gate.if).toBe("always()");
        expect(gate["continue-on-error"]).toBeUndefined();
        const step = gate.steps[0];
        expect(step.env.E2E_RESULT).toBe("${{ needs.e2e-test.result }}");
        expect(step["continue-on-error"]).toBeUndefined();
        for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
            const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
                env: { ...process.env, E2E_RESULT: outcome },
            });
            expect(result.status, outcome).toBe(outcome === "success" ? 0 : 1);
        }
        const tests = matrix.steps.find((value: { id?: string; }) => value.id === "tests");
        expect(tests.run).toContain('elif [[ "$project" =~ ^new-3[ab]$ ]]; then');
        expect(tests.run).toContain('--project="$project" --reporter=line,json,html');
        expect(tests.run).toContain("--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10");
    });
});
