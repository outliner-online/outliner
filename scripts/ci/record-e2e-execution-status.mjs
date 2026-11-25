#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const file = "job_logs/execution-context.json";
const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const runtimeFile = process.env.E2E_BROWSER_RUNTIME_REPORT;
if (runtimeFile && fs.existsSync(runtimeFile)) {
    record.browserRuntimeProbe = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    record.browserVersion = record.browserRuntimeProbe.browserVersion;
    record.playwrightVersion = record.browserRuntimeProbe.playwrightVersion;
    record.playwrightVersionSource = "Firefox runtime probe";
}
record.status = process.env.E2E_JOB_STATUS;
record.steps = JSON.parse(process.env.E2E_STEP_OUTCOMES);
if (process.env.E2E_BROWSER === "firefox") {
    const executionFile = path.resolve("client", process.env.E2E_EXECUTION_REPORT);
    if (fs.existsSync(executionFile)) {
        const execution = JSON.parse(fs.readFileSync(executionFile, "utf8"));
        record.testExecution = {
            status: execution.status,
            ...execution.counts,
            report: path.relative(process.cwd(), executionFile),
        };
    } else if (record.steps.tests && record.steps.tests.outcome !== "skipped") {
        record.testExecution = { status: "unobserved", collected: null, executed: null, attempts: null };
    }
}
record.finishedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record));
