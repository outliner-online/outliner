import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expectedOrigin = "https://outliner-online.com";
const legacyOrigin = "https://outliner-d57b0.web.app";
const defaultBuildDirectory = resolve(import.meta.dirname, "../../build");
const defaultResolverModule = resolve(
    import.meta.dirname,
    "../.svelte-kit/output/server/chunks/firebaseFunctionsUrl.js",
);

async function filesBelow(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(path) : [path];
    }));
    return nested.flat();
}

async function loadEmittedResolver(resolverModule) {
    const emittedModule = await import(pathToFileURL(resolverModule).href);
    const functions = Object.values(emittedModule).filter(value => typeof value === "function");
    if (functions.length !== 1) {
        throw new Error(`Expected one function export in emitted Firebase resolver, found ${functions.length}`);
    }
    return functions[0];
}

export async function verifyProductionBuild({
    buildDirectory = defaultBuildDirectory,
    resolverModule = defaultResolverModule,
} = {}) {
    // Execute the resolver emitted by the real SvelteKit production build. Export
    // names are minified, so identify the chunk's sole function export by value.
    const emittedResolver = await loadEmittedResolver(resolverModule);
    for (const functionName of ["getUserProjects", "saveProject"]) {
        const expectedUrl = `${expectedOrigin}/api/${functionName}`;
        const actualUrl = emittedResolver(functionName);
        if (actualUrl !== expectedUrl) {
            throw new Error(`Emitted Firebase resolver returned ${actualUrl}; expected ${expectedUrl}`);
        }
    }

    // Retain textual checks as secondary guards for stale and legacy configuration.
    const emittedFiles = (await filesBelow(buildDirectory)).filter(path => [".html", ".js"].includes(extname(path)));
    const emittedText = (await Promise.all(emittedFiles.map(path => readFile(path, "utf8")))).join("\n");
    if (!emittedText.includes(expectedOrigin)) {
        throw new Error(`Production build does not contain the expected Firebase API origin: ${expectedOrigin}`);
    }
    if (emittedText.includes(legacyOrigin)) {
        throw new Error(`Production build still contains the legacy Firebase API origin: ${legacyOrigin}`);
    }

    console.log(`Verified emitted Firebase API routes resolve against: ${expectedOrigin}`);
}

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : resolve(process.argv[index + 1]);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
    await verifyProductionBuild({
        buildDirectory: option("--build-dir", defaultBuildDirectory),
        resolverModule: option("--resolver-module", defaultResolverModule),
    });
}
