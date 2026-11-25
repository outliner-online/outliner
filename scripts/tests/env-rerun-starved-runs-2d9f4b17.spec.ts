import { expect, test } from "vitest";
import {
    assignedJob,
    failedJobsEndpoint,
    job,
    jobsEndpoint,
    jobsResponse,
    recoveryWorkflow,
    runRecovery,
    step,
    wholeRunEndpoint,
} from "./helpers/rerun-starved-harness";
import { condition } from "./helpers/workflow-harness";

/** @feature ENV-2d9f4b17
 *  Title   : Workflow runs starved of a hosted runner are re-queued automatically
 *  Source  : docs/dev-features/env-rerun-starved-runs-2d9f4b17.yaml
 */

test("the watcher retains its triggers, permissions and five-minute budget", () => {
    expect(recoveryWorkflow.on).toEqual({
        workflow_run: {
            workflows: [
                "CI",
                "Uptime Monitor",
                "Build and Push Server Container",
                "Build Test Container",
                "Deploy",
                "Sync to GitLab",
                "Stryker Nightly Mutation",
            ],
            types: ["completed"],
        },
    });
    expect(recoveryWorkflow.permissions).toEqual({ actions: "write", contents: "read" });
    expect(recoveryWorkflow.jobs.rerun["timeout-minutes"]).toBe(5);
});

test.each(["cancelled", "success", "timed_out"])("a %s run does not enter recovery", conclusion => {
    const eligible = condition(recoveryWorkflow.jobs.rerun.if, { github: { event: { workflow_run: { conclusion } } } },
        { failed: false, cancelled: false });
    expect(eligible).toBe(false);
});

test("a failed run enters recovery", () => {
    expect(
        condition(recoveryWorkflow.jobs.rerun.if, { github: { event: { workflow_run: { conclusion: "failure" } } } }, {
            failed: false,
            cancelled: false,
        }),
    ).toBe(true);
});

test("a job that waited out the acquisition timeout re-queues the failed jobs", async () => {
    const result = await runRecovery([jobsResponse()]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("never reached a runner");
    expect(result.output).toContain("Re-queued the failed jobs of run 123 (attempt 3)");
    expect(result.requests).toEqual([`GET ${jobsEndpoint}`, `POST ${failedJobsEndpoint}`]);
});

test.each([
    ["an assigned failed job without steps", assignedJob()],
    ["a short ordinary cancellation", job({ completed_at: "2026-08-06T21:00:41Z" })],
    ["a genuine failed test", assignedJob({ steps: [step("Test", "completed", "failure")] })],
    ["an unfamiliar failure with terminal steps", assignedJob({ steps: [step("Upload", "completed", "cancelled")] })],
])("%s stays failed", async (_, fixture) => {
    const result = await runRecovery([jobsResponse([fixture])]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("No job in run 123 was starved");
    expect(result.requests).toEqual([`GET ${jobsEndpoint}`]);
});

test("a lost runner with frozen steps and no failed verdict re-queues the failed jobs", async () => {
    const result = await runRecovery([jobsResponse([assignedJob({
        steps: [
            step("Set up job", "completed", "success"),
            step("Startup", "in_progress", null),
            step("Test", "pending", null),
        ],
    })])]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("lost their runner");
    expect(result.requests).toEqual([`GET ${jobsEndpoint}`, `POST ${failedJobsEndpoint}`]);
});

test("the attempt cap prevents even the jobs read", async () => {
    const result = await runRecovery([], { attempt: 3 });
    expect(result.status).toBe(0);
    expect(result.output).toContain("already used 3 of 3 attempts");
    expect(result.requests).toEqual([]);
});

test("a rejected failed-jobs rerun retains the single whole-run fallback", async () => {
    const result = await runRecovery([jobsResponse()], { writes: [{ status: 422 }, { status: 201 }] });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Re-queued run 123 (attempt 3)");
    expect(result.requests).toEqual([`GET ${jobsEndpoint}`, `POST ${failedJobsEndpoint}`, `POST ${wholeRunEndpoint}`]);
});

test("neither rerun write is retried when both writes fail", async () => {
    const result = await runRecovery([jobsResponse()], { writes: [{ status: 502 }, { status: 502 }] });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("Re-queued");
    expect(result.requests).toEqual([`GET ${jobsEndpoint}`, `POST ${failedJobsEndpoint}`, `POST ${wholeRunEndpoint}`]);
});
