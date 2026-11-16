import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(client, "node_modules/playwright/cli.js");
const testModule = pathToFileURL(join(client, "node_modules/@playwright/test/index.mjs")).href;
const workflow = readFileSync(join(client, "../.github/workflows/ci-test-e2e.yml"), "utf8");

test.each([
    { step: "Record retry-free Grid clipboard verification", count: 2 },
    { step: "Record retry-free Grid resize wheel verification", count: 1 },
])("$step retains primary-suite failed-attempt attachments and HTML report", ({ step, count }) => {
    const root = mkdtempSync(join(tmpdir(), "new2-retention-"));
    const cwd = join(root, "client");
    mkdirSync(join(cwd, "cases"), { recursive: true });
    writeFileSync(join(cwd, "cases/probe.spec.mjs"), `
        import { test, expect } from ${JSON.stringify(testModule)};
        import { writeFileSync } from 'node:fs';
        test('primary failure then retry', async ({}, info) => {
            if (process.env.RETENTION_PRIMARY === '1' && info.retry === 0) {
                const file = info.outputPath('grid-diagnostic.json');
                writeFileSync(file, '{"observed":"initial failure"}');
                await info.attach('grid-diagnostic', {path: file, contentType: 'application/json'});
                expect('actual').toBe('intentional first-attempt failure');
            }
        });
    `);
    writeFileSync(join(cwd, "playwright.config.mjs"), `export default {
        testDir: './cases', outputDir: './test-results', workers: 1, retries: 1,
        reporter: [['html', {open: 'never'}], ['json', {outputFile: '../job_logs/results.json'}]]
    };`);
    const env = { ...process.env };
    delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
    delete env.PLAYWRIGHT_HTML_OUTPUT_DIR;
    const run = (args: string[], extra: Record<string, string>) => {
        const result = spawnSync(process.execPath, [cli, "test", ...args], {
            cwd,
            env: { ...env, ...extra },
            encoding: "utf8",
            timeout: 15000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    try {
        run([], { RETENTION_PRIMARY: "1" });
        const report = JSON.parse(readFileSync(join(root, "job_logs/results.json"), "utf8"));
        expect(report.stats.flaky).toBe(1);
        const attachment = report.suites[0].specs[0].tests[0].results[0].attachments[0].path;
        const bytes = readFileSync(attachment);
        const htmlPath = join(cwd, "playwright-report/index.html");
        const html = readFileSync(htmlPath);
        const verification = workflow.split(`- name: ${step}`)[1]
            .split("- name:")[0];
        const outputs = [...verification.matchAll(/--output=(\S+)/g)].map(match => match[1]);
        const reports = [...verification.matchAll(/PLAYWRIGHT_HTML_OUTPUT_DIR=(\S+)/g)].map(match => match[1]);
        expect(outputs).toHaveLength(count);
        expect(reports).toHaveLength(count);
        expect(new Set(outputs).size).toBe(count);
        expect(new Set(reports).size).toBe(count);
        for (let index = 0; index < count; index++) {
            // Run the real CLI with exactly the output/report paths selected by CI.
            // No browser or application mock: this isolates Playwright's cleanup boundary.
            run([`--output=${outputs[index]}`, "--retries=0"], {
                PLAYWRIGHT_HTML_OUTPUT_DIR: reports[index],
                RETENTION_PRIMARY: "0",
            });
            expect(readFileSync(attachment)).toEqual(bytes);
            expect(readFileSync(htmlPath)).toEqual(html);
        }
        // Reproduce the previous CI boundary: default paths delete the same
        // attachment and replace the primary report even though every run succeeds.
        run(["--retries=0"], { RETENTION_PRIMARY: "0" });
        expect(existsSync(attachment)).toBe(false);
        expect(readFileSync(htmlPath)).not.toEqual(html);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 60000);
