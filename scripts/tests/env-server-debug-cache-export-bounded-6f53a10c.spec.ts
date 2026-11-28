import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

/** @feature ENV-6f53a10c
 *  Title: Bounded optional server debug cache export
 *  Source: docs/dev-features/cic-server-debug-cache-export-bounded-6f53a10c.yaml
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci-docker-build.yml"), "utf8"));
const job = workflow.jobs["server-debug-image"];
const steps = job.steps as Array<Record<string, any>>;
const step = (name: string): Record<string, any> => {
    const found = steps.find((candidate) => candidate.name === name);
    expect(found, `server-debug-image must retain ${name}`).toBeDefined();
    return found!;
};

describe("server debug image cache export", () => {
    const build = step("Build server debug image");
    const cacheExport = step("Export server debug image cache");
    const diagnostic = step("Report incomplete server debug image cache export");
    const nativeSmoke = step("Verify native modules load in the built image");
    const offlineSmoke = step("Verify both SQLite bindings and SQL engines in the debug image");

    test("loads the authoritative image before a bounded optional cache export", () => {
        expect(job["timeout-minutes"]).toBe(30);
        expect(build.with).toMatchObject({
            context: ".",
            file: "./server/Dockerfile.debug",
            push: false,
            load: true,
            tags: "yjs-ws-server:ci-debug",
            "cache-from": "type=gha,scope=server-debug-image",
        });
        expect(build.with["cache-to"]).toBeUndefined();
        expect(build["continue-on-error"]).toBeUndefined();

        expect(cacheExport).toMatchObject({
            id: "debug-cache-export",
            uses: "docker/build-push-action@v7",
            "timeout-minutes": 5,
            "continue-on-error": true,
        });
        expect(cacheExport.with).toMatchObject({
            context: ".",
            file: "./server/Dockerfile.debug",
            push: false,
            load: false,
            "cache-from": "type=gha,scope=server-debug-image",
            "cache-to": "type=gha,mode=max,scope=server-debug-image",
        });
        expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(cacheExport));
        expect(steps.indexOf(cacheExport)).toBeLessThan(steps.indexOf(nativeSmoke));
        expect(steps.indexOf(cacheExport)).toBeLessThan(steps.indexOf(offlineSmoke));
    });

    test.each(["failure", "cancelled"])(
        "a prompt error or bounded delay with outcome %s remains visible and reaches both smokes",
        (outcome) => {
            expect(cacheExport["continue-on-error"]).toBe(true);
            expect(cacheExport["timeout-minutes"]).toBeLessThan(job["timeout-minutes"]);
            expect(diagnostic.if).toBe("steps.debug-cache-export.outcome != 'success'");
            expect(diagnostic.env.CACHE_EXPORT_OUTCOME).toBe("${{ steps.debug-cache-export.outcome }}");
            expect(diagnostic.run).toContain("::warning::Optional server debug image cache export did not complete");
            expect(["failure", "cancelled"]).toContain(outcome);
            expect(nativeSmoke.if).toBeUndefined();
            expect(offlineSmoke.if).toBeUndefined();
        },
    );

    test("both required smokes use only the freshly loaded debug tag and remain blocking", () => {
        for (const smoke of [nativeSmoke, offlineSmoke]) {
            expect(smoke["continue-on-error"]).toBeUndefined();
            expect(smoke.if).toBeUndefined();
            expect(smoke.run).toContain("yjs-ws-server:ci-debug");
            expect(smoke.run).not.toContain("pull");
        }
        expect(nativeSmoke.run).toContain("better-sqlite3 binding OK");
        expect(nativeSmoke.run).toContain("firebase-admin/firestore binding OK");
        expect(offlineSmoke.run).toContain("--network none");
        expect(offlineSmoke.run).toContain("node26-committed-image-smoke.mjs");
    });
});
