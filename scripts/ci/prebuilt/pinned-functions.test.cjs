// Resolver contract tests with private synthetic packages, not real SDK/emulator proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { loadPinnedHttps } = require("./pinned-functions.cjs");
const { createRequire } = require("node:module");
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-functions-contract-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const functions = path.join(root, "functions");
    const modules = path.join(functions, "node_modules");
    const sdk = path.join(modules, "firebase-functions");
    fs.mkdirSync(path.join(sdk, "lib/v2/providers"), { recursive: true });
    const record = { version: "7.4.0", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") };
    const pkg = {
        name: "firebase-functions",
        version: "7.4.0",
        exports: { "./v2/https": { require: "./lib/v2/providers/https.js" } },
    };
    writeJson(path.join(functions, "package.json"), { name: "private-fixture" });
    writeJson(path.join(functions, "package-lock.json"), { packages: { "node_modules/firebase-functions": record } });
    writeJson(path.join(modules, ".package-lock.json"), { packages: { "node_modules/firebase-functions": record } });
    writeJson(path.join(sdk, "package.json"), pkg);
    const entry = path.join(sdk, "lib/v2/providers/https.js");
    fs.writeFileSync(entry, 'exports.onRequest = () => "private-local-sdk";\n');
    return { root, functions, modules, sdk, entry, pkg, record };
}

test("normal package export works while old absolute subpath does not", t => {
    const f = fixture(t);
    assert.throws(() => require(path.join(f.sdk, "v2/https")), { code: "MODULE_NOT_FOUND" });
    assert.equal(loadPinnedHttps(f.root).onRequest(), "private-local-sdk");
});

test("missing direct local SDK cannot fall back to a parent package", t => {
    const f = fixture(t);
    const parentModules = path.join(f.root, "node_modules");
    fs.mkdirSync(parentModules);
    fs.renameSync(f.sdk, path.join(parentModules, "firebase-functions"));
    const fallback = createRequire(path.join(f.functions, "package.json"));
    assert.equal(fallback("firebase-functions/v2/https").onRequest(), "private-local-sdk");
    assert.throws(() => loadPinnedHttps(f.root));
});

test("wrong package identity rejected", t => {
    const f = fixture(t);
    f.pkg.name = "another-package";
    writeJson(path.join(f.sdk, "package.json"), f.pkg);
    assert.throws(() => loadPinnedHttps(f.root));
});

test("wrong installed version rejected", t => {
    const f = fixture(t);
    f.pkg.version = "7.4.1";
    writeJson(path.join(f.sdk, "package.json"), f.pkg);
    assert.throws(() => loadPinnedHttps(f.root));
});

test("wrong installed integrity record rejected", t => {
    const f = fixture(t);
    writeJson(path.join(f.modules, ".package-lock.json"), {
        packages: {
            "node_modules/firebase-functions": { ...f.record, integrity: "sha512-d3Jvbmc=" },
        },
    });
    assert.throws(() => loadPinnedHttps(f.root));
});

test("missing install record rejected", t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.modules, ".package-lock.json"));
    assert.throws(() => loadPinnedHttps(f.root));
});

test("missing locked integrity rejected", t => {
    const f = fixture(t);
    delete f.record.integrity;
    writeJson(path.join(f.functions, "package-lock.json"), {
        packages: { "node_modules/firebase-functions": f.record },
    });
    assert.throws(() => loadPinnedHttps(f.root));
});

test("changed export mapping rejected before running alternate module", t => {
    const f = fixture(t);
    f.pkg.exports["./v2/https"].require = "./other.js";
    fs.writeFileSync(path.join(f.sdk, "other.js"), 'throw new Error("must not execute");');
    writeJson(path.join(f.sdk, "package.json"), f.pkg);
    assert.throws(() => loadPinnedHttps(f.root), /Unexpected HTTPS export/);
});

test("condition-selected export cannot redirect to another entry", t => {
    const f = fixture(t);
    f.pkg.exports["./v2/https"] = { node: "./other.js", require: "./lib/v2/providers/https.js" };
    fs.writeFileSync(path.join(f.sdk, "other.js"), 'throw new Error("must not execute");');
    writeJson(path.join(f.sdk, "package.json"), f.pkg);
    assert.throws(() => loadPinnedHttps(f.root), /HTTPS export resolves outside pinned entry/);
});

test("missing mapped export file rejected", t => {
    const f = fixture(t);
    fs.unlinkSync(f.entry);
    assert.throws(() => loadPinnedHttps(f.root));
});

test("symlinked SDK outside local directory rejected", t => {
    const f = fixture(t);
    const moved = path.join(f.root, "elsewhere");
    fs.renameSync(f.sdk, moved);
    fs.symlinkSync(moved, f.sdk);
    assert.throws(() => loadPinnedHttps(f.root));
});

test("symlinked entry outside pinned package rejected", t => {
    const f = fixture(t);
    const outside = path.join(f.root, "outside.js");
    fs.writeFileSync(outside, 'throw new Error("must not execute");');
    fs.unlinkSync(f.entry);
    fs.symlinkSync(outside, f.entry);
    assert.throws(() => loadPinnedHttps(f.root));
});

test("wrong exported API rejected", t => {
    const f = fixture(t);
    fs.writeFileSync(f.entry, "exports.onRequest = 1;");
    assert.throws(() => loadPinnedHttps(f.root));
});

test("fixture staging and CI invoke this resolver and its tests", () => {
    const fixtureText = fs.readFileSync(path.join(__dirname, "fixture.cjs"), "utf8");
    assert.match(fixtureText, /loadPinnedHttps\("\/prepared\/source"\)/);
    const prepare = fs.readFileSync(path.join(__dirname, "prepare-fixture.py"), "utf8");
    assert.match(prepare, /functions\/pinned-functions.cjs/);
    const workflow = fs.readFileSync(path.join(__dirname, "../../../.github/workflows/ci-test-container-build.yml"),
        "utf8");
    assert.match(workflow, /node --test .*pinned-functions.test.cjs/);
});
