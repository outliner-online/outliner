#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const libCoverage = require("../../client/node_modules/istanbul-lib-coverage");
const artifactDir = path.resolve(process.argv[2] ?? "unit-artifacts");
const shardCount = Number(process.argv[3] ?? 2);
if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("invalid shard count");
const fullOutput = execFileSync(path.resolve("client/node_modules/.bin/vitest"), ["list", "--project", "unit",
    "--filesOnly"], { cwd: path.resolve("client"), encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
const normalize = (text) =>
    [...new Set(
        text.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
            /\.(?:test|spec)\.(?:js|ts|svelte)$/.test(line)
        ),
    )].sort();
const full = normalize(fullOutput);
const selected = [];
const coverageMap = libCoverage.createCoverageMap();
for (let shard = 1; shard <= shardCount; shard++) {
    const shardDir = path.join(artifactDir,
        `unit-shard-${shard}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
    const selectionPath = path.join(shardDir, "unit-evidence", `shard-${shard}.txt`);
    const coveragePath = path.join(shardDir, "coverage", `unit-shard-${shard}`, "coverage-final.json");
    if (!fs.existsSync(selectionPath)) throw new Error(`missing current-attempt selection evidence for shard ${shard}`);
    selected.push(...normalize(fs.readFileSync(selectionPath, "utf8")));
    if (!fs.existsSync(coveragePath)) throw new Error(`missing current-attempt coverage for shard ${shard}`);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
    if (Object.keys(coverage).length === 0) throw new Error(`empty coverage for shard ${shard}`);
    coverageMap.merge(coverage);
}
const union = [...new Set(selected)].sort();
const duplicates = selected.filter((value, index) => selected.indexOf(value) !== index);
if (duplicates.length) throw new Error(`tests assigned more than once: ${[...new Set(duplicates)].join(", ")}`);
if (JSON.stringify(union) !== JSON.stringify(full)) {
    const missing = full.filter((file) => !union.includes(file));
    const extra = union.filter((file) => !full.includes(file));
    throw new Error(
        `shard selection differs from native selection; missing=${missing.join(",")} extra=${extra.join(",")}`,
    );
}
const output = path.resolve("coverage/unit_and_integration/coverage-final.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(coverageMap.toJSON()));
console.log(`Verified ${full.length} unique unit files across ${shardCount} shards and merged complete coverage.`);
