import { type Page, test as base, type TestInfo } from "@playwright/test";
import fs from "fs/promises";

/**
 * Mirrors `GridRenderTrace` from
 * `client/src/services/yjstable/gridRenderTrace.ts` structurally rather than
 * importing it: e2e/ is a separate TypeScript project from src/ (see
 * client/e2e/tsconfig.json, which excludes ../src), and the trace crosses the
 * page boundary as JSON anyway.
 */
export interface GridRenderTraceSnapshot {
    version: number;
    gridId: string;
    sourceDiagnostics: {
        execution: { current: boolean; };
        dependencies: { status: string; relations: { id: string; sqlName: string; }[]; };
    };
    projectId?: string;
    generatedAt: string;
    stages: readonly unknown[];
}

interface GridRenderTraceGlobal {
    __outlinerGridRenderTraces?: { collect: () => GridRenderTraceSnapshot[]; };
    __gridClipboardDiagnostic?: unknown;
    __YJS_STORE__?: {
        currentProjectId?: string;
        isConnected?: boolean;
        yjsClient?: {
            getProject: () => {
                ydoc?: { guid: string; share: Map<string, { keys?: () => IterableIterator<string>; }>; };
            };
        };
    };
}

export async function recordGridClipboardDiagnostic(page: Page, patch: Record<string, unknown>): Promise<void> {
    await page.evaluate(value => {
        Object.assign((globalThis as unknown as GridRenderTraceGlobal).__gridClipboardDiagnostic as object, value);
    }, patch);
}

export async function readClipboardAndRecord(page: Page): Promise<string> {
    return page.evaluate(async () => {
        const text = await navigator.clipboard.readText();
        Object.assign((globalThis as unknown as GridRenderTraceGlobal).__gridClipboardDiagnostic as object, {
            clipboardText: text,
        });
        return text;
    });
}

/**
 * Pulls every currently-registered Grid render trace out of the page via the
 * always-on bridge installed by `gridRenderTraceRegistry.ts`. Returns `[]`
 * when no Grid is mounted, or when running against a build that predates the
 * registry (older client bundle, or a non-Grid page).
 *
 * Reads `globalThis` rather than `window` (both are the same object in a
 * page.evaluate callback): this file's e2e/ ESLint config bans the `window`
 * identifier outright to keep tests from coupling to global state.
 */
export async function collectGridRenderTraces(page: Page): Promise<GridRenderTraceSnapshot[]> {
    return page.evaluate(() =>
        (globalThis as unknown as GridRenderTraceGlobal).__outlinerGridRenderTraces?.collect() ?? []
    );
}

/**
 * Attaches the given traces to the current test's report: one JSON file per
 * Grid plus an index that correlates them with the failing test, its page
 * URL, and every captured Grid's id — everything a coding agent needs to
 * locate and open the right file among the other CI artifacts (screenshots,
 * videos, logs) without touching those.
 *
 * Written to real files under `testInfo.outputPath()` (inside
 * `client/test-results/<test-id>/`) rather than passed as an in-memory
 * `body`: `client/test-results/` is archived for failing jobs, and for `new-2` even
 * when retries make the job succeed (see `.github/workflows/ci-test-e2e.yml`).
 * A `body` attachment is
 * only recoverable from the JSON reporter's own output file, which is not
 * always enabled.
 *
 * Exported standalone (not only wired into the `page` fixture below) so it
 * can be exercised directly and its output files inspected without
 * depending on fixture teardown timing.
 */
export async function attachGridRenderTraces(
    testInfo: TestInfo,
    traces: readonly GridRenderTraceSnapshot[],
    context: { url?: string; label?: string; } = {},
): Promise<void> {
    if (traces.length === 0) return;

    const index = {
        test: testInfo.titlePath.join(" > "),
        file: testInfo.file,
        project: testInfo.project.name,
        retry: testInfo.retry,
        url: context.url,
        label: context.label,
        gridIds: traces.map(trace => trace.gridId),
    };
    const prefix = context.label ? `${context.label}-` : "";
    await writeJsonAttachment(testInfo, `${prefix}grid-render-trace-index.json`, index);

    for (const trace of traces) {
        await writeJsonAttachment(testInfo, `${prefix}grid-render-trace-${trace.gridId}.json`, trace);
    }
}

async function writeJsonAttachment(testInfo: TestInfo, name: string, content: unknown): Promise<void> {
    const path = testInfo.outputPath(name);
    await fs.writeFile(path, JSON.stringify(content, null, 2), "utf8");
    await testInfo.attach(name, { path, contentType: "application/json" });
}

async function boundedDiagnostic<T>(read: () => Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Diagnostic read budget exhausted");
        return await Promise.race([
            read(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Diagnostic read budget exhausted")), remaining);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Capture the page that actually failed, before its caller's finally closes it. */
export async function withGridFailureCapture<T>(
    page: Page,
    testInfo: TestInfo,
    label: string,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (originalFailure) {
        // One six-second budget for all reads, rather than three independent
        // two-second caps that can reject a late read despite unused time.
        const deadline = Date.now() + 6000;
        const errors: { stage: string; message: string; }[] = [];
        const capture = async (stage: string, read: () => Promise<unknown>) => {
            try {
                await read();
            } catch (error) {
                errors.push({ stage, message: String(error) });
            }
        };
        await capture("page-state", async () => {
            const state = await boundedDiagnostic(() => page.evaluate(() => {
                const dom = globalThis.document;
                const store = (globalThis as unknown as GridRenderTraceGlobal).__YJS_STORE__;
                const project = store?.yjsClient?.getProject();
                // share.get reads existing types; getMap could create a missing map.
                const ids = (name: string) => {
                    const registry = project?.ydoc?.share.get(name);
                    return registry?.keys ? Array.from(registry.keys()) : undefined;
                };
                const gridIds = ids("yjsGrids");
                const tableIds = ids("yjsTables");
                return {
                    url: globalThis.location.href,
                    readyState: dom.readyState,
                    hasFocus: dom.hasFocus(),
                    activeElement: {
                        tag: dom.activeElement?.tagName,
                        testId: dom.activeElement?.getAttribute("data-testid"),
                        className: dom.activeElement?.getAttribute("class"),
                    },
                    projectId: store?.currentProjectId,
                    connected: store?.isConnected,
                    projectDocumentId: project?.ydoc?.guid,
                    registryAvailable: { grids: gridIds !== undefined, tables: tableIds !== undefined },
                    gridIds,
                    tableIds,
                    domGridIds: Array.from(dom.querySelectorAll('[data-testid="yjs-table-view"]'),
                        element => element.getAttribute("data-grid-id")),
                };
            }), deadline);
            await writeJsonAttachment(testInfo, `${label}-page-state.json`, { label, retry: testInfo.retry, ...state });
        });
        await capture("page-snapshot", async () => {
            const snapshot = await boundedDiagnostic(
                () => page.locator("body").ariaSnapshot({ timeout: Math.max(1, deadline - Date.now()) }),
                deadline,
            );
            const path = testInfo.outputPath(`${label}-page-snapshot.yaml`);
            await fs.writeFile(path, snapshot, "utf8");
            await testInfo.attach(`${label}-page-snapshot.yaml`, { path, contentType: "text/yaml" });
        });
        await capture("grid-traces", async () => {
            const traces = await boundedDiagnostic(() => collectGridRenderTraces(page), deadline);
            await attachGridRenderTraces(testInfo, traces, { url: page.url(), label });
        });
        if (errors.length) {
            try {
                await writeJsonAttachment(testInfo, `${label}-capture-errors.json`, { label, url: page.url(), errors });
            } catch (error) {
                console.warn("[grid-render-trace] failed to retain capture errors:", error);
            }
        }
        throw originalFailure;
    }
}

/**
 * Grid E2E specs should import `test`/`expect` from here instead of
 * `@playwright/test` directly. On a failing (or timed-out) test, its
 * teardown captures whatever Grid render traces are live in the page and
 * attaches them to the test report — see docs/e2e-grid-render-trace-artifacts.md.
 *
 * This never replaces or delays existing screenshot/video/log capture: it
 * only adds attachments after the test body has already run.
 */
export const test = base.extend({
    page: async ({ page }, use, testInfo) => {
        await use(page);

        if (testInfo.status === testInfo.expectedStatus) return;
        try {
            const traces = await collectGridRenderTraces(page);
            await attachGridRenderTraces(testInfo, traces, { url: page.url() });
            const diagnostic = await page.evaluate(() =>
                (globalThis as unknown as GridRenderTraceGlobal).__gridClipboardDiagnostic
                    ?? { unavailable: "Grid clipboard diagnostic was not initialized" }
            );
            await writeJsonAttachment(testInfo, "grid-clipboard-diagnostic.json", diagnostic);
        } catch (error) {
            // Best-effort diagnostics: a page already closed/crashed after a
            // failure must never mask the original failure or fail the test
            // a second time over missing trace data.
            console.warn("[grid-render-trace] failed to capture render trace artifact:", error);
        }
    },
});

export { expect } from "@playwright/test";
