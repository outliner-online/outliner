#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [coveragePath, outputPath] = process.argv.slice(2);
if (!coveragePath || !outputPath) throw new Error("coverage and output paths are required");
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
const schema = Object.fromEntries(Object.entries(coverage).map(([file, data]) => [file, {
    statementMap: data.statementMap,
    fnMap: data.fnMap,
    branchMap: data.branchMap,
}]));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(schema));
