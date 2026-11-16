import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    testMatch: ["**/hosting-schedule/sch-standalone-hosting-contract-a43ce270.spec.ts",
        "**/schedule/sch-stryker-nightly-schedule-visibility-2c9b1a4d.spec.ts"],
    timeout: 30000,
    workers: 1,
    retries: 0,
    use: { baseURL: "http://127.0.0.1:57100", headless: true, trace: "off", screenshot: "off", video: "off" },
    reporter: "list",
});
