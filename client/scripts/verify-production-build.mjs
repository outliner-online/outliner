import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const expectedOrigin = "https://outliner-online.com";
const legacyOrigin = "https://outliner-d57b0.web.app";
const distDirectory = new URL("../../build/", import.meta.url);

async function filesBelow(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => {
        const path = join(directory.pathname, entry.name);
        return entry.isDirectory() ? filesBelow(new URL(`${entry.name}/`, directory)) : [path];
    }));
    return nested.flat();
}

const emittedFiles = (await filesBelow(distDirectory)).filter(path => [".html", ".js"].includes(extname(path)));
const emittedText = (await Promise.all(emittedFiles.map(path => readFile(path, "utf8")))).join("\n");

if (!emittedText.includes(expectedOrigin)) {
    throw new Error(`Production build does not contain the expected Firebase API origin: ${expectedOrigin}`);
}
if (emittedText.includes(legacyOrigin)) {
    throw new Error(`Production build still contains the legacy Firebase API origin: ${legacyOrigin}`);
}

console.log(`Verified production build Firebase API origin: ${expectedOrigin}`);
