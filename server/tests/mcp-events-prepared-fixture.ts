import {
    type PreparedViewChange,
    summarizeViewChange,
    type ViewChangeAttemptOutcome,
    type ViewChangeRevalidation,
} from "../src/notifications/prepared-view-change.js";

/** Narrow final-guard fixture only; the production observer success path has separate live-source coverage. */
export function preparedFixture() {
    let current = true;
    let status: "current" | "cancelled" | "deferred" = "current";
    const settled: ViewChangeAttemptOutcome[] = [];
    const grid = (value: string) => ({
        kind: "grid" as const,
        title: "Visible",
        columns: [{ label: "Title" }],
        rows: [[{ value }]],
    });
    const prepared: PreparedViewChange = {
        uid: "owner",
        eventId: "exact-A-to-B",
        ruleId: "rule",
        channel: "mcp",
        target: { projectId: "project", kind: "grid", objectId: "grid" },
        observedAt: new Date().toISOString(),
        settingsRevision: 1,
        sourceVersionToken: "private-token",
        effectiveContext: { version: 1, surface: "table", locale: "en-US", timeZone: "UTC" },
        deepLink: "https://outliner.example/project/grid?context=exact",
        summary: summarizeViewChange(grid("A"), grid("B")),
        async revalidate(): Promise<ViewChangeRevalidation> {
            return status === "current"
                ? { status, candidate: { ...prepared, isCurrent: () => current } }
                : { status, reason: "changed" };
        },
        settleAttempt(value) {
            settled.push(value);
        },
    };
    return {
        prepared,
        settled,
        stale() {
            current = false;
        },
        set status(value: typeof status) {
            status = value;
        },
    };
}
