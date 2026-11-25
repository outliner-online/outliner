// Evaluate the shipped upload expressions and paths for isolated real outcomes.
// This is test-only evaluation of repository-owned workflow code.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const steps = parse(fs.readFileSync(path.join(root, ".github/workflows/ci-test-e2e.yml"), "utf8"))
    .jobs["e2e-test"].steps;
const uploads = steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
if (!process.argv[2]) {
    const app = createRequire(import.meta.url)(path.join(root, "ecosystem.config.cjs"))
        .apps.find(app => app.name === "yjs-server");
    console.log(JSON.stringify({
        startup: steps.find(step => step.id === "startup").run,
        follower: steps.find(step => step.id === "tests").run.split('project="')[0],
        verify: steps.find(step => step.id === "startup_evidence").run,
        serviceLog: path.normalize(path.join(app.cwd, app.out_file)),
    }));
} else {
    const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const selected = uploads.filter(step =>
        Function("always", "failure", "cancelled", "startsWith", "matrix", "steps", `return (${step.if})`)(
            () => true,
            () => state.failure,
            () => state.cancelled,
            (value, prefix) => value.startsWith(prefix),
            { project: state.project },
            state.steps,
        )
    ).map(step => ({
        name: step.name,
        paths: step.with.path.replace(/\$\{\{\s*(.*?)\s*\}\}/g,
            (_match, expression) => Function("steps", `return (${expression})`)(state.steps)).trim().split(/\s*\n\s*/),
    }));
    console.log(JSON.stringify(selected));
}
