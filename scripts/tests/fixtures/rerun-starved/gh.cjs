#!/usr/bin/env node
// Test-only GitHub CLI boundary: bash, jq, timeouts and retry delays remain real.
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.RECOVERY_API_FIXTURE;
const args = process.argv.slice(2);
let method = "GET";
let endpoint;
let include = false;
if (args[0] !== "api") throw new Error("Only the GitHub API boundary is supported");
for (let index = 1; index < args.length; index++) {
    if (["-X", "--method"].includes(args[index])) method = args[++index];
    else if (["-i", "--include"].includes(args[index])) include = true;
    else if (!endpoint && !args[index].startsWith("-")) endpoint = args[index];
    else throw new Error(`Unexpected GitHub CLI argument: ${args[index]}`);
}
const callsFile = path.join(directory, "calls.jsonl");
const previous = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
fs.appendFileSync(callsFile, JSON.stringify({
    method,
    endpoint,
    args,
    at: Number(process.hrtime.bigint() / 1000000n),
}) + "\n");
const plan = JSON.parse(fs.readFileSync(path.join(directory, "responses.json"), "utf8"));
const index = previous.filter(call => call.method === method).length;
const response = (method === "GET" ? plan.reads : plan.writes)[index];
if (!response) throw new Error(`Unexpected ${method} request ${index + 1} to ${endpoint}`);
if (include) process.stdout.write(`HTTP/2.0 ${response.status}\r\nContent-Type: application/json\r\n\r\n`);
process.stdout.write(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {}));
if (response.status >= 400) process.stderr.write(`gh: fixture API error (HTTP ${response.status})\n`);
process.exitCode = response.status >= 400 ? 1 : 0;
