import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e/deployed",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120000,
    expect: { timeout: 30000 },
    use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.DEPLOYED_DEMO_URL ?? "https://outliner-online.com",
        headless: true,
        // A deployed smoke check must fail while the custom-domain certificate is invalid.
        ignoreHTTPSErrors: false,
        permissions: ["clipboard-read", "clipboard-write"],
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
});
