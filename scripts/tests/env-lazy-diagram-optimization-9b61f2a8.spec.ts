import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/** @feature ENV-9b61f2a8
 * Source: docs/dev-features/env-lazy-diagram-optimization-9b61f2a8.yaml
 */
test("the default E2E Vite config pre-bundles both lazy diagram dependencies on a cold cache", () => {
    const probe = `
        import { resolveConfig, optimizeDeps } from "vite";
        import { mkdtemp, rm, stat } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        const cacheDir = await mkdtemp(join(tmpdir(), "outliner-diagram-deps-"));
        try {
            // No explicit configFile: exercise the same selection as vite dev.
            const config = await resolveConfig({ cacheDir, mode: "test", logLevel: "silent" }, "serve");
            const metadata = await optimizeDeps(config, true);
            console.log("PROBE" + JSON.stringify({
                configFile: config.configFile,
                optimized: Object.keys(metadata.optimized),
                emittedBytes: await Promise.all(["dompurify", "mermaid"].map(async id => {
                    const info = metadata.optimized[id];
                    return info ? (await stat(info.file)).size : 0;
                })),
            }));
        } finally {
            await rm(cacheDir, { recursive: true, force: true });
        }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: fileURLToPath(new URL("../../client", import.meta.url)),
        encoding: "utf8",
        timeout: 55_000,
        env: { ...process.env, NODE_ENV: "test" },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, output).toBe(0);
    const record = result.stdout.split("\n").find(line => line.startsWith("PROBE"));
    expect(record, output).toBeDefined();
    const observed = JSON.parse(record!.slice(5));
    expect(observed.configFile).toMatch(/\/vite\.config\.js$/);
    expect(observed.optimized).toEqual(expect.arrayContaining(["dompurify", "mermaid"]));
    expect(observed.emittedBytes).toHaveLength(2);
    for (const bytes of observed.emittedBytes) expect(bytes).toBeGreaterThan(0);
});
