import { expect, test } from "vitest";
import {
    assignedJob,
    failedJobsEndpoint,
    job,
    jobsEndpoint,
    jobsResponse,
    runRecovery,
    step,
} from "./helpers/rerun-starved-harness";

/** @feature ENV-2d9f4b17
 *  Title   : Recovery retries transient job-list reads without inventing runner-loss evidence
 *  Source  : docs/dev-features/env-rerun-starved-runs-2d9f4b17.yaml
 */

const gatewayFailure = { status: 502, body: "Bad Gateway" };
const get = `GET ${jobsEndpoint}`;
const noClassification = /never reached a runner|lost their runner|No job in run|Re-queued/;

const expectUnavailable = (result: Awaited<ReturnType<typeof runRecovery>>, expectedReads: number) => {
    expect(result.status).toBe(1);
    expect(result.output).toMatch(
        /(?:unavailable|invalid).*?(?:evidence|job)|(?:evidence|job).*?(?:unavailable|invalid)/i,
    );
    expect(result.output).not.toMatch(noClassification);
    expect(result.requests).toEqual(Array(expectedReads).fill(get));
};

test("a transient 502 retries the same attempt before classifying eligible jobs", async () => {
    const result = await runRecovery([gatewayFailure, jobsResponse()]);
    expect(result.status).toBe(0);
    expect(result.requests).toEqual([get, get, `POST ${failedJobsEndpoint}`]);
    expect(result.output).toContain("never reached a runner");
    expect(result.output).toContain("Re-queued the failed jobs of run 123 (attempt 3)");
    expect(result.calls[1].at - result.calls[0].at).toBeGreaterThanOrEqual(2000);
    expect(result.elapsed).toBeLessThan(30_000);
});

test("a 502 followed by an authoritative failed test does not rerun", async () => {
    const result = await runRecovery([gatewayFailure, jobsResponse([assignedJob({
        steps: [step("Test", "completed", "failure")],
    })])]);
    expect(result.status).toBe(0);
    expect(result.requests).toEqual([get, get]);
    expect(result.output).toContain("No job in run 123 was starved");
    expect(result.output).not.toMatch(/never reached a runner|lost their runner|Re-queued/);
});

test("exhausted gateway failures stop after three reads and bounded real delays", async () => {
    const result = await runRecovery([gatewayFailure, gatewayFailure, gatewayFailure]);
    expectUnavailable(result, 3);
    expect(result.calls[1].at - result.calls[0].at).toBeGreaterThanOrEqual(2000);
    expect(result.calls[2].at - result.calls[1].at).toBeGreaterThanOrEqual(4000);
    expect(result.elapsed).toBeLessThan(30_000);
});

test.each([503, 504])("a transient HTTP %i also permits a bounded read retry", async status => {
    const result = await runRecovery([{ status }, jobsResponse()]);
    expect(result.status).toBe(0);
    expect(result.requests).toEqual([get, get, `POST ${failedJobsEndpoint}`]);
});

test.each([401, 403, 404, 429])("HTTP %i is not retried or treated as eligibility", async status => {
    // A queued valid response catches accidental retries of authentication, permission or rate-limit failures.
    expectUnavailable(await runRecovery([{ status }, jobsResponse()]), 1);
});

const missingStepStatus = assignedJob({ steps: [{ number: 1, name: "Test", conclusion: null }] });
const missingStepConclusion = assignedJob({ steps: [{ number: 1, name: "Test", status: "in_progress" }] });

test.each([
    ["malformed JSON", '{"jobs":'],
    ["missing job list", {}],
    ["assigned failed job missing step status", { total_count: 1, jobs: [missingStepStatus] }],
    ["assigned failed job missing step conclusion", { total_count: 1, jobs: [missingStepConclusion] }],
    ["assigned failed job with unknown step status", {
        total_count: 1,
        jobs: [assignedJob({ steps: [step("Test", "unknown", null)] })],
    }],
    ["multiple JSON documents", JSON.stringify({ total_count: 1, jobs: [job()] }) + "\n{}"],
    ["incomplete page", { total_count: 2, jobs: [job()] }],
    ["wrong run identity", { total_count: 1, jobs: [job({ run_id: 999 })] }],
    ["wrong attempt identity", { total_count: 1, jobs: [job({ run_attempt: 1 })] }],
])("HTTP 200 with %s is explicitly invalid before any classification", async (_, body) => {
    // The second response must remain unused: retrying malformed success bodies can hide unavailable evidence.
    expectUnavailable(await runRecovery([{ status: 200, body }, jobsResponse()]), 1);
});

test("one incomplete job prevents classification of an otherwise eligible sibling", async () => {
    expectUnavailable(await runRecovery([{
        status: 200,
        body: { total_count: 2, jobs: [job(), { ...missingStepStatus, id: 457 }] },
    }]), 1);
});

test("a complete first page keeps the existing recovery route when more than 100 jobs exist", async () => {
    const jobs = Array.from({ length: 100 }, (_, index) => job({
        id: 456 + index,
        name: `job-${index}`,
        conclusion: index === 0 ? "cancelled" : "success",
    }));
    const result = await runRecovery([{ status: 200, body: { total_count: 101, jobs } }]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("1 job(s) in run 123 never reached a runner");
    expect(result.requests).toEqual([get, `POST ${failedJobsEndpoint}`]);
});
