import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const Mocha = createRequire(path.join(process.cwd(), "package.json"))("mocha");
const Spec = Mocha.reporters.Spec;

export default class ServerTestReporter extends Spec {
    constructor(runner, options) {
        super(runner, options);
        const tests = [];
        runner.on("test end", test => tests.push({
            file: path.relative(process.cwd(), test.file ?? ""),
            title: test.fullTitle(),
            state: test.state ?? "unknown",
        }));
        runner.once("end", () => {
            const output = process.env.SERVER_TEST_REPORT;
            if (!output) throw new Error("SERVER_TEST_REPORT is required");
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, JSON.stringify({ tests }, undefined, 2));
        });
    }
}
