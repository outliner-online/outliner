// Read-only local resolution fence; never search another package/version on error.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function loadPinnedHttps(sourceRoot) {
    const source = fs.realpathSync(sourceRoot);
    const functions = path.join(source, "functions");
    const expected = readJson(path.join(functions, "package-lock.json")).packages["node_modules/firebase-functions"];
    if (!expected?.version || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected.integrity || "")) {
        throw new Error("Missing pinned Functions SDK");
    }
    const directory = path.join(functions, "node_modules/firebase-functions");
    if (fs.realpathSync(directory) !== directory) throw new Error("SDK outside fixed local directory");
    const installed = readJson(path.join(directory, "package.json"));
    const record =
        readJson(path.join(functions, "node_modules/.package-lock.json")).packages["node_modules/firebase-functions"];
    if (
        installed.name !== "firebase-functions" || installed.version !== expected.version
        || record?.version !== expected.version || record.integrity !== expected.integrity
    ) {
        throw new Error("Installed Functions SDK differs from lock");
    }
    // Verified CJS export in official 7.4.0 metadata; no absolute package subpath.
    const entry = "./lib/v2/providers/https.js";
    if (installed.exports?.["./v2/https"]?.require !== entry) throw new Error("Unexpected HTTPS export");
    const local = createRequire(path.join(functions, "package.json"));
    const resolved = fs.realpathSync(local.resolve("firebase-functions/v2/https"));
    const canonical = path.join(directory, entry);
    if (resolved !== canonical || fs.realpathSync(canonical) !== canonical) {
        throw new Error("HTTPS export resolves outside pinned entry");
    }
    const api = local("firebase-functions/v2/https");
    if (typeof api.onRequest !== "function") throw new Error("Missing HTTPS API");
    return { onRequest: api.onRequest };
}

module.exports = { loadPinnedHttps };
