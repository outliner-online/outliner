import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../../");
const vitepress = join(repoRoot, "node_modules/vitepress/bin/vitepress.js");

test("the utils investigation renders Actions expressions literally", () => {
    const outDir = mkdtempSync(join(tmpdir(), "outliner-vitepress-"));

    try {
        execFileSync(process.execPath, [vitepress, "build", "docs", "--outDir", outDir], {
            cwd: repoRoot,
            stdio: "pipe",
        });

        const html = readFileSync(join(outDir, "ci-utils-startup-interruption-6040.html"), "utf8");
        for (
            const expression of [
                "ci-${{ github.workflow }}-${{ github.ref }}",
                "e2e-${{ github.workflow }}-${{ github.ref }}",
            ]
        ) {
            assert.match(html, new RegExp(`<code>${escapeRegExp(expression)}</code>`));
        }
    } finally {
        rmSync(outDir, { recursive: true, force: true });
    }
});

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
