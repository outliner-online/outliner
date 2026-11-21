import fs from "node:fs";

const [repository, runId, currentAttemptText, output] = process.argv.slice(2);
const currentAttempt = Number(currentAttemptText);
if (!repository || !runId || !Number.isInteger(currentAttempt) || currentAttempt < 1 || !output) {
    throw new Error("usage: collect-new4-shard-outcomes.mjs REPOSITORY RUN_ID CURRENT_ATTEMPT OUTPUT");
}
if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required");

const shards = {};
for (let attempt = 1; attempt <= currentAttempt; attempt++) {
    const runResponse = await fetch(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}` } },
    );
    if (!runResponse.ok) throw new Error(`Cannot read workflow attempt ${attempt}: ${runResponse.status}`);
    const attemptStartedAt = new Date((await runResponse.json()).run_started_at).getTime();
    if (!Number.isFinite(attemptStartedAt)) throw new Error(`Workflow attempt ${attempt} has no start time`);

    const jobsResponse = await fetch(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}` } },
    );
    if (!jobsResponse.ok) throw new Error(`Cannot read jobs for attempt ${attempt}: ${jobsResponse.status}`);
    const payload = await jobsResponse.json();
    for (const index of [1, 2]) {
        const name = `e2e-test (new-4-${index})`;
        const jobs = payload.jobs.filter(job =>
            (job.name === name || job.name.endsWith(` / ${name}`))
            && new Date(job.started_at).getTime() >= attemptStartedAt
        );
        if (jobs.length > 1) throw new Error(`Workflow attempt ${attempt} contains duplicate ${name} jobs`);
        if (jobs.length === 1) {
            shards[index] = { attempt, conclusion: jobs[0].conclusion, jobId: jobs[0].id };
        }
    }
}

fs.writeFileSync(output, JSON.stringify({ runId, currentAttempt, shards }, null, 2) + "\n");
