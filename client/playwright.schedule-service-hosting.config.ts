import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e/hosting-schedule",
    testMatch: "sch-service-hosting-contract-4d23a6b8.spec.ts",
    timeout: 30000,
    workers: 1,
    retries: 0,
    use: { baseURL: "http://127.0.0.1:57100", headless: true, trace: "off", screenshot: "off", video: "off" },
    reporter: "list",
});
