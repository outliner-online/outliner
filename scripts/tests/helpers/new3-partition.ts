import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { type CollectedCase, collectPlaywright } from "./playwright-collection";

const halves = ["new-3a", "new-3b"];
const key = (test: CollectedCase) => JSON.stringify([test.file, test.line, ...test.titles]);

/** Compare actual CI-context collection with an independent inventory of the old selection. */
export function verifyNew3Partition(client: string, workflow: string) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "new3-inventory-"));
    try {
        const inventory = path.join(temporary, "playwright.config.mjs");
        fs.writeFileSync(
            inventory,
            `export default {
                testDir: ${JSON.stringify(path.join(client, "e2e/new"))},
                testMatch: ["**/[defghi]*.spec.ts"],
                forbidOnly: true,
                projects: [{ name: "old-new3-inventory", use: { browserName: "chromium" } }]
            };`,
        );
        const expected = collectPlaywright(client, inventory).cases;
        if (!expected.length) throw new Error("Old new-3 inventory is empty");
        const document = parse(fs.readFileSync(workflow, "utf8"));
        const matrix = document.jobs["e2e-test"].strategy.matrix;
        // Explicitly reject unsupported scheduling changes instead of assuming coverage.
        if (Object.keys(matrix).some(axis => axis !== "project")) {
            throw new Error("Cannot verify new-3 matrix modifiers or extra axes");
        }
        for (const half of halves) {
            if (matrix.project.filter((project: string) => project === half).length !== 1) {
                throw new Error(`CI must schedule ${half} exactly once`);
            }
        }
        if (matrix.project.includes("new-3")) throw new Error("CI still schedules the unsplit new-3 project");
        const actual = halves.flatMap(project =>
            collectPlaywright(client, undefined, { project, browser: "chromium" }).cases
        );
        const expectedKeys = new Set(expected.map(key));
        const actualKeys = actual.map(key);
        if (new Set(actualKeys).size !== actualKeys.length) throw new Error("Duplicate new-3 case across halves");
        const actualSet = new Set(actualKeys);
        const missing = [...expectedKeys].filter(value => !actualSet.has(value));
        const extra = actualKeys.filter(value => !expectedKeys.has(value));
        if (missing.length || extra.length) {
            throw new Error(`New-3 partition mismatch: missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
        }
        if (actual.some(test => test.browser !== "chromium")) throw new Error("New-3 engine changed");
        return {
            expected: expected.length,
            halves: halves.map(project => actual.filter(test => test.project === project).length),
        };
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
