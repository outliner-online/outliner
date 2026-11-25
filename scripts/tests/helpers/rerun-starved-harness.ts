import fs from "fs";
import os from "os";
import path from "path";
import { loadWorkflow, repoRoot, runJob } from "./workflow-harness";

export const recoveryWorkflow = loadWorkflow("ci-rerun-starved-runs.yml");
export const jobsEndpoint = "repos/owner/repo/actions/runs/123/attempts/2/jobs?per_page=100";
export const failedJobsEndpoint = "repos/owner/repo/actions/runs/123/rerun-failed-jobs";
export const wholeRunEndpoint = "repos/owner/repo/actions/runs/123/rerun";

export interface ApiResponse {
    status: number;
    body?: unknown;
}

interface ApiCall {
    method: string;
    endpoint: string;
    args: string[];
    at: number;
}

export const job = (overrides: Record<string, unknown> = {}) => ({
    id: 456,
    run_id: 123,
    run_attempt: 2,
    name: "pr-guards",
    status: "completed",
    conclusion: "cancelled",
    runner_id: 0,
    runner_name: "",
    started_at: "2026-08-06T21:00:18Z",
    completed_at: "2026-08-06T21:15:21Z",
    steps: [],
    ...overrides,
});

export const step = (name: string, status: string, conclusion: string | null) => ({
    number: 1,
    name,
    status,
    conclusion,
});

export const assignedJob = (overrides: Record<string, unknown> = {}) => job({
    conclusion: "failure",
    runner_id: 789,
    runner_name: "GitHub Actions 1000273556",
    started_at: "2026-10-10T09:35:29Z",
    completed_at: "2026-10-10T09:36:22Z",
    ...overrides,
});

export const jobsResponse = (jobs = [job()]): ApiResponse => ({
    status: 200,
    body: { total_count: jobs.length, jobs },
});

/** Execute the shipped workflow command and script, replacing only `gh` at the API boundary. */
export async function runRecovery(
    reads: ApiResponse[],
    options: { attempt?: number; writes?: ApiResponse[]; } = {},
) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-starved-"));
    try {
        const executable = path.join(directory, "gh");
        fs.copyFileSync(path.join(repoRoot, "scripts/tests/fixtures/rerun-starved/gh.cjs"), executable);
        fs.chmodSync(executable, 0o755);
        fs.writeFileSync(path.join(directory, "responses.json"), JSON.stringify({
            reads,
            writes: options.writes ?? [{ status: 201 }],
        }));
        const started = performance.now();
        const result = await runJob("ci-rerun-starved-runs.yml", "rerun", {
            github: {
                repository: "owner/repo",
                event_name: "workflow_run",
                event: { workflow_run: { id: 123, run_attempt: options.attempt ?? 2, conclusion: "failure" } },
            },
            secrets: { GITHUB_TOKEN: "fixture-only-token" },
        }, repoRoot, {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            RECOVERY_API_FIXTURE: directory,
            MAX_ATTEMPTS: "3",
            MIN_QUEUED_SECONDS: "600",
        });
        const commands = result.steps.filter(({ skipped }) => !skipped);
        if (commands.length !== 1) throw new Error("Expected the shipped recovery command to execute once");
        const callsFile = path.join(directory, "calls.jsonl");
        const calls: ApiCall[] = fs.existsSync(callsFile)
            ? fs.readFileSync(callsFile, "utf-8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
            : [];
        return {
            status: commands[0].status,
            output: commands[0].output,
            calls,
            requests: calls.map(({ method, endpoint }) => `${method} ${endpoint}`),
            elapsed: performance.now() - started,
        };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
