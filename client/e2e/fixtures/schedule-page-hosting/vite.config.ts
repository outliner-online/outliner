import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    root,
    envDir: false,
    plugins: [svelte({ configFile: false })],
    resolve: { alias: { $lib: path.resolve(root, "../../../src/lib") } },
    build: {
        outDir: process.env.SCHEDULE_HOSTING_BUILD_DIR || path.resolve(root, "../../../../.schedule-hosting-build"),
        emptyOutDir: true,
    },
});
