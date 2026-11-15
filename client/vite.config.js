import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { sveltekitOptions } from "./sveltekit.options.js";

export default defineConfig({
    // Vite selects this config for dev/E2E (before vite.config.ts). The lazy
    // diagram renderer imports both dependencies; discovering them mid-session
    // re-optimizes shared chunks and reloads every open test page.
    optimizeDeps: { include: ["dompurify", "mermaid"] },
    plugins: [
        paraglideVitePlugin({ project: "./project.inlang", outdir: "./src/paraglide./src/lib/paraglide" }),
        tailwindcss(),
        sveltekit(sveltekitOptions),
    ],
    build: {
        // Output to the public directory for Firebase Hosting
        outDir: "../build",
        emptyOutDir: true,
        // Run in SPA mode
        ssr: false,
        // Output as a static site
        target: "esnext",
        // Threshold for inlining assets such as images
        assetsInlineLimit: 10000,
    },
});
