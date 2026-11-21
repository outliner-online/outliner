#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const artifactDir = path.resolve(process.argv[2] ?? "unit-artifacts");
const shardCount = Number(process.argv[3] ?? 2);
if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("invalid shard count");
const fullOutput = execFileSync(path.resolve("client/node_modules/.bin/vitest"), ["list", "--project", "unit",
    "--filesOnly"], { cwd: path.resolve("client"), encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
const normalize = (text) =>
    [...new Set(
        text.split(/\r?\n/).map((line) => line.trim().replace(/^\[unit\]\s+/, "")).map((line) =>
            path.isAbsolute(line) ? path.relative(path.resolve("client"), line) : line
        ).filter((line) => /\.(?:test|spec)\.(?:js|ts|svelte)$/.test(line)),
    )].sort();
const full = normalize(fullOutput);
const selected = [];
const mergedCoverage = {};
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
    for (const [file, data] of Object.entries(coverage)) {
        if (!mergedCoverage[file]) {
            mergedCoverage[file] = structuredClone(data);
            continue;
        }
        const target = mergedCoverage[file];
        for (const key of Object.keys(data.s)) target.s[key] = (target.s[key] ?? 0) + data.s[key];
        for (const key of Object.keys(data.f)) target.f[key] = (target.f[key] ?? 0) + data.f[key];
        for (const [key, counts] of Object.entries(data.b)) {
            const prior = target.b[key] ?? counts.map(() => 0);
            target.b[key] = counts.map((count, index) => (prior[index] ?? 0) + count);
        }
    }
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
fs.writeFileSync(output, JSON.stringify(mergedCoverage));
console.log(`Verified ${full.length} unique unit files across ${shardCount} shards and merged complete coverage.`);
