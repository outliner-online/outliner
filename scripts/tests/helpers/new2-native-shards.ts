import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { type CollectedCase, collectPlaywright } from "./playwright-collection";

const key = (test: CollectedCase) => JSON.stringify([test.file, test.line, ...test.titles]);

export function verifyNew2NativeShards(client: string, workflow: string) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "new2-native-inventory-"));
    try {
        const config = path.join(temporary, "playwright.config.mjs");
        fs.writeFileSync(
            config,
            `export default {
                testDir: ${JSON.stringify(path.join(client, "e2e/new"))},
                testMatch: ["**/c*.spec.ts"], forbidOnly: true,
                projects: [{ name: "old-new2-inventory", use: { browserName: "chromium" } }]
            };`,
        );
        const expected = collectPlaywright(client, config).cases;
        if (!expected.length) throw new Error("Old new-2 inventory is empty");
        const document = parse(fs.readFileSync(workflow, "utf8"));
        const matrix = document.jobs["e2e-test"].strategy.matrix;
        if (Object.keys(matrix).some(axis => axis !== "project")) {
            throw new Error("Cannot verify new-2 matrix modifiers or extra axes");
        }
        for (const row of ["new-2-1", "new-2-2"]) {
            if (matrix.project.filter((project: string) => project === row).length !== 1) {
                throw new Error(`CI must schedule ${row} exactly once`);
            }
        }
        if (matrix.project.includes("new-2")) throw new Error("CI still schedules unsplit new-2");
        const halves = ["1/2", "2/2"].map(shard =>
            collectPlaywright(client, undefined, { project: "new-2", browser: "chromium", shard }).cases
        );
        if (halves.some(half => !half.length)) throw new Error("An actual new-2 shard is empty");
        const actual = halves.flat();
        const keys = actual.map(key);
        if (new Set(keys).size !== keys.length) throw new Error("Duplicate new-2 case across shards");
        const actualKeys = new Set(keys);
        const expectedKeys = new Set(expected.map(key));
        const missing = [...expectedKeys].filter(value => !actualKeys.has(value));
        const extra = keys.filter(value => !expectedKeys.has(value));
        if (missing.length || extra.length) {
            throw new Error(`New-2 shard mismatch: missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
        }
        if (actual.some(test => test.browser !== "chromium")) throw new Error("New-2 engine changed");
        return { expected: expected.length, halves: halves.map(half => half.length) };
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
