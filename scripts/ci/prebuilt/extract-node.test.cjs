// Synthetic text archives only; no downloaded Node binary is installed/executed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { extract } = require("./extract-node.cjs");
const sha = data => crypto.createHash("sha256").update(data).digest("hex");

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-gzip-contract-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const top = path.join(dir, "source/node-fixture/bin");
    fs.mkdirSync(top, { recursive: true });
    fs.writeFileSync(path.join(top, "payload.txt"), "fixture bytes, never executable\n");
    const made = spawnSync("tar", ["-cf", "-", "-C", path.join(dir, "source"), "node-fixture"]);
    assert.equal(made.status, 0);
    const bytes = zlib.gzipSync(made.stdout);
    const archive = path.join(dir, "node-fixture.tar.gz");
    fs.writeFileSync(archive, bytes);
    return { dir, archive, bytes, destination: path.join(dir, "output") };
}

test("real tar extraction through Node gzip without gzip or xz commands", t => {
    const f = fixture(t);
    const bin = path.join(f.dir, "only-tar");
    fs.mkdirSync(bin);
    const found = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" });
    assert.equal(found.status, 0);
    fs.symlinkSync(found.stdout.trim(), path.join(bin, "tar"));
    const run = spawnSync(process.execPath, [path.join(__dirname, "extract-node.cjs"), f.archive, sha(f.bytes),
        f.destination], {
        env: { ...process.env, PATH: bin },
        timeout: 5000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0);
    assert.equal(fs.readFileSync(path.join(f.destination, "bin/payload.txt"), "utf8"),
        "fixture bytes, never executable\n");
});

test("wrong digest refuses before creating destination", async t => {
    const f = fixture(t);
    await assert.rejects(extract(f.archive, "0".repeat(64), f.destination));
    assert.equal(fs.existsSync(f.destination), false);
});

test("missing archive refuses before creating destination", async t => {
    const f = fixture(t);
    await assert.rejects(extract(path.join(f.dir, "missing"), sha(f.bytes), f.destination));
    assert.equal(fs.existsSync(f.destination), false);
});

test("truncated gzip with matching digest still fails", async t => {
    const f = fixture(t);
    const broken = f.bytes.subarray(0, f.bytes.length - 10);
    fs.writeFileSync(f.archive, broken);
    await assert.rejects(extract(f.archive, sha(broken), f.destination));
});

test("invalid tar inside valid gzip fails", async t => {
    const f = fixture(t);
    const broken = zlib.gzipSync(Buffer.from("not a tar archive"));
    fs.writeFileSync(f.archive, broken);
    await assert.rejects(extract(f.archive, sha(broken), f.destination));
});

test("destination creation failure is not success", async t => {
    const f = fixture(t);
    fs.writeFileSync(f.destination, "a file");
    await assert.rejects(extract(f.archive, sha(f.bytes), f.destination));
});

test("missing tar command fails with explicit nonzero CLI outcome", t => {
    const f = fixture(t);
    const run = spawnSync(process.execPath, [path.join(__dirname, "extract-node.cjs"), f.archive, sha(f.bytes),
        f.destination], {
        env: { ...process.env, PATH: f.dir },
        timeout: 5000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 1);
});
