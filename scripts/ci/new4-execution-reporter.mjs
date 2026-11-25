import fs from "node:fs";
import path from "node:path";

const key = test => JSON.stringify([test.location.file, test.location.line, ...test.titlePath()]);

export default class New4ExecutionReporter {
    onBegin(config, suite) {
        this.rootDir = config.rootDir;
        this.tests = new Map(suite.allTests().map(test => [key(test), {
            file: path.relative(config.rootDir, test.location.file).split(path.sep).join("/"),
            line: test.location.line,
            titles: test.titlePath().slice(3),
            attempts: [],
        }]));
    }

    onTestEnd(test, result) {
        const record = this.tests.get(key(test));
        if (!record) throw new Error("new-4 execution reporter observed an uncollected test");
        record.attempts.push({ retry: result.retry, status: result.status });
    }

    onEnd(result) {
        const output = process.env.NEW4_EXECUTION_REPORT;
        if (!output) throw new Error("NEW4_EXECUTION_REPORT is required");
        fs.writeFileSync(output, JSON.stringify({
            mode: "execution",
            status: result.status,
            engine: process.env.E2E_BROWSER,
            project: process.env.E2E_PROJECT,
            ciShard: process.env.NEW4_CI_SHARD,
            shard: process.env.NEW4_NATIVE_SHARD,
            executionId: process.env.E2E_EXECUTION_ID,
            commit: process.env.GITHUB_SHA,
            cases: [...this.tests.values()],
        }, null, 2) + "\n");
    }
}
