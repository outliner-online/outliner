// No install, fallback executable, network navigation or credential access.
const fs = require("node:fs");
const path = require("node:path");
async function check(root) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "client/package-lock.json"), "utf8"));
    const modules = path.join(root, "client/node_modules");
    for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
        const installed = JSON.parse(fs.readFileSync(path.join(modules, name, "package.json"), "utf8"));
        if (installed.version !== lock.packages[`node_modules/${name}`].version) throw new Error("SDK mismatch");
    }
    const sdk = require(path.join(modules, "playwright"));
    const result = {};
    for (const name of ["chromium", "firefox"]) {
        if (!fs.statSync(sdk[name].executablePath()).isFile()) throw new Error("Missing locked browser");
        const browser = await sdk[name].launch({ headless: true, timeout: 10000 });
        try {
            const page = await browser.newPage();
            await page.setContent("<title>prepared runtime</title>");
            if (await page.title() !== "prepared runtime") throw new Error("Browser execution failed");
        } finally {
            await browser.close();
        }
        result[name] = "launched-and-closed";
    }
    return result;
}
module.exports = { check };
if (require.main === module) {
    check(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(() => {
        console.error("Locked browser check failed");
        process.exitCode = 1;
    });
}
