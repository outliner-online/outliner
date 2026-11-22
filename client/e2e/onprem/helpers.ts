import { expect, type Page, type TestInfo } from "@playwright/test";
import { OnPremProductionStack } from "./onpremProductionStack";

export async function login(page: Page, stack: OnPremProductionStack, password = stack.password) {
    await page.goto(stack.origin);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    // The click only dispatches the async login handler. Do not let callers
    // navigate until the UI has consumed either the session or its rejection;
    // an immediate navigation can abort that work and leave a fresh context
    // unauthenticated even though login() already returned.
    await expect(
        page.getByTestId("login-status-indicator").filter({ hasText: "Local User" })
            .or(page.getByText("Incorrect password", { exact: true })),
    ).toBeVisible();
}

export async function createProject(page: Page, title: string) {
    await page.getByRole("link", { name: /Create New Outliner/ }).click();
    await page.getByLabel("Outliner Name").fill(title);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${encodeURIComponent(title)}$`), { timeout: 30_000 });
}

export function stackFor(testInfo: TestInfo) {
    return new OnPremProductionStack(testInfo.workerIndex);
}
