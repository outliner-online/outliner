// Bootstrap with the existing pinned Playwright base's Node standard library.
// SHA256 is verified BEFORE extraction; no external gzip/xz, installer or shell.
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");

async function extract(archive, expected, destination) {
    if (!/^[0-9a-f]{64}$/.test(expected || "") || !archive || !destination) throw new Error("Invalid supply arguments");
    const hash = crypto.createHash("sha256");
    for await (const block of fs.createReadStream(archive)) hash.update(block);
    if (hash.digest("hex") !== expected) throw new Error("Supply digest mismatch");
    await fs.promises.mkdir(destination, { recursive: true });
    const tar = spawn("tar", ["-xf", "-", "--strip-components=1", "-C", destination], {
        stdio: ["pipe", "ignore", "ignore"],
    });
    const completed = new Promise((resolve, reject) => {
        tar.once("error", reject);
        tar.once("close", code => code === 0 ? resolve() : reject(new Error("Tar failed")));
    });
    const outcomes = await Promise.allSettled([
        pipeline(fs.createReadStream(archive), zlib.createGunzip(), tar.stdin),
        completed,
    ]);
    if (outcomes.some(result => result.status !== "fulfilled")) throw new Error("Verified supply extraction failed");
}

module.exports = { extract };
if (require.main === module) {
    extract(...process.argv.slice(2)).catch(() => {
        console.error("Verified Node archive extraction failed");
        process.exitCode = 1;
    });
}
