import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// Run after npm run build:production. This reads emitted code, never source env files.
const chunks = new URL("../.svelte-kit/output/server/chunks/", import.meta.url);
const compiled = await import(new URL("firebaseFunctionsUrl.js", chunks));
const resolver = Object.values(compiled).find(value =>
    typeof value === "function" && value.name === "getFirebaseFunctionUrl"
);
assert.ok(resolver, "Production output must export the actual Functions URL helper");
for (const name of ["getUserProjects", "saveProject", "deleteProject", "health"]) {
    assert.equal(resolver(name), `https://outliner-online.com/api/${name}`);
}

for (
    const [name, path] of Object.entries({
        createSchedule: "create-schedule",
        listSchedules: "list-schedules",
        updateSchedule: "update-schedule",
        cancelSchedule: "cancel-schedule",
        exportSchedulesIcal: "export-schedules-ical",
    })
) {
    assert.equal(resolver(name), `https://outliner-online.com/api/${path}`);
}

const assets = new URL("../../build/_app/immutable/", import.meta.url);
const files = await readdir(assets, { recursive: true });
const javascript = (await Promise.all(files.filter(file => file.endsWith(".js"))
    .map(file => readFile(new URL(file, assets), "utf8")))).join("\n");
for (
    const value of [
        "https://outliner-online.com",
        "outliner-d57b0.firebaseapp.com",
        "wss://outliner-yjs-ws.outliner-online.com",
    ]
) assert.ok(javascript.includes(value), `Browser output missing ${value}`);
assert.ok(!javascript.includes("https://outliner-d57b0.web.app"), "Legacy API origin in browser output");
assert.ok(/VITE_FIREBASE_PROJECT_ID["'`]?\s*:\s*["'`]outliner-d57b0["'`]/.test(javascript),
    "Browser Firebase project changed");
console.log("PASS: emitted production resolver and browser API/Auth/project/Yjs configuration (REQ-001–006)");
console.log("Live HTTPS, popup sign-in and authenticated API requests were NOT executed by this build check.");
