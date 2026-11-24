# utils startup interruption investigation (#6040)

## Conclusion

Repository-visible evidence does not identify the source of the shutdown sent to
the `utils` runner. The job was on a GitHub-hosted runner, its direct-runner
setup and server build had succeeded, and its bounded service-startup command
had run for less than two seconds when the runner reported the shutdown. The
Playwright step never started. Nothing in the available run, job, check, log, or
concurrent-run evidence establishes a repository-controlled defect, deliberate
cancellation, or GitHub infrastructure fault.

Accordingly, this investigation does not change the startup code, tests, shard
selection, required checks, timeouts, concurrency, retry, or result-reporting
policy. The native job correctly remained a failure rather than turning an
interrupted startup into a successful test result.

## Interrupted execution

The affected execution was the `push` event for main commit
`7f95019a6db1c5a0dc802b842c15d216f8d8981c`: [CI run 45404009640, attempt 1,
job 138480815784](https://github.com/outliner-online/outliner/actions/runs/45404009640/job/138480815784).
The run API identifies the workflow as `.github/workflows/ci.yml` and both the
actor and triggering actor as `kitamura-tetsuo`; those fields attribute creation
of the run, not a subsequent shutdown. The job API reports:

- name `e2e-test / e2e-test (utils)`;
- runner `GitHub Actions 1000028278`, runner group `GitHub Actions`, and label
  `ubuntu-latest`;
- start at 2026-11-24 13:31:36 UTC, completion at 13:33:35 UTC, and native
  conclusion `failure`;
- successful dependency setup through 13:33:24 UTC and successful server build
  through 13:33:31 UTC;
- cancelled `Run E2E-specific startup (services + readiness)` from 13:33:31 to
  13:33:33 UTC; and
- a skipped `Run E2E tests (utils)` step.

The log records `Direct-runner stage: ready` followed by
`stage=ready exit=0 elapsed=29s aggregate-budget=600s` at 13:33:24.667 UTC. At
13:33:33.802 UTC, while `scripts/ci/run-e2e-startup.sh` was still active, the
runner emitted `The runner has received a shutdown signal`; at 13:33:33.913 UTC
it emitted `The operation was canceled`. Orphan-process cleanup follows those
messages. The check-run API adds only a failure annotation saying the operation
was canceled. It does not identify the initiator.

This sequence is authoritative evidence that the runner received a shutdown
and that startup and tests did not complete. It is not evidence that an APT or
browser install failed, a test assertion failed, the repository requested the
shutdown, a person cancelled the job, or GitHub evicted the host.

## Workflow and repository comparison

The job log says the reusable workflow was
`outliner-online/outliner/.github/workflows/ci-test-e2e.yml@refs/heads/main` and
resolved it to the same `7f95019a...` commit. The triggering commit changed only
the client Svelte package and lockfile; it did not change `.github/workflows/ci.yml`,
`.github/workflows/ci-test-e2e.yml`, `scripts/ci/run-e2e-startup.sh`, or
`scripts/ci-e2e-start.sh`. Those four files are byte-for-byte unchanged from the
immediately preceding main commit `acfc423a5abc0836c1fb904ab31be210e96bce93`.

At the affected revision, the outer CI workflow used concurrency group
<code v-pre>ci-${{ github.workflow }}-${{ github.ref }}</code> with
`cancel-in-progress: true`.
The reusable E2E workflow independently used
<code v-pre>e2e-${{ github.workflow }}-${{ github.ref }}</code> with
`cancel-in-progress: true`.
The E2E matrix used `fail-fast: false`, included the ordinary `utils` project,
and retained its 30-minute job timeout. The job stopped about two minutes after
it began, so the job timeout was not reached. Other matrix shards continued
after the `utils` failure, which is consistent with the configured fail-fast
policy.

The startup wrapper's own termination logic is deadline-driven and was not at a
deadline: the startup step had run for roughly two seconds against a 360-second
startup timeout and a 1,320-second remaining-job budget. Its service cleanup
targets repository-started Firebase and server processes, not the Actions
runner service. No wrapper completion or timeout record preceded the
runner-originated shutdown message.

## Concurrent and comparable native evidence

There was no newer CI run on `main` at the shutdown time. The preceding CI
execution that could have shared a concurrency group was run 45397132498 for
`acfc423a5...`; that run had already completed at 13:26:18 UTC, more than seven
minutes before the shutdown. The next records in the time window were skipped
`Rerun Starved Runs` workflow-run handlers, not newer CI executions. Other
workflows triggered by the same `7f95019a...` push used different workflow
identities and do not demonstrate cancellation of this job.

The closest native control is the immediately preceding main CI execution:
[run 45397132498, utils job 138457033164](https://github.com/outliner-online/outliner/actions/runs/45397132498/job/138457033164).
It used the same workflow and startup files, reached direct-runner ready with
exit 0 in 31 seconds, then ran the existing `utils` selection and reported all
13 tests passed. It completed successfully at 12:53:26 UTC on hosted runner
`GitHub Actions 1000028093`. Additional recent main jobs also completed the
ordinary `utils` shard successfully:

| Run         | Commit                                     | Job          | Runner                      | Native result |
| ----------- | ------------------------------------------ | ------------ | --------------------------- | ------------- |
| 45297447467 | `35c53f740f3bf03d3f6e9e15da1e87e5124004f5` | 138122165999 | `GitHub Actions 1000027013` | `success`     |
| 45185316009 | `c3d2fe50639ace04672eeb028fada11991e6956f` | 137730473497 | `GitHub Actions 1000025471` | `success`     |
| 44987698254 | `01d6c39a475c5f54a004ce546f30f5b5405a945b` | 137102330806 | `GitHub Actions 1000019970` | `success`     |
| 44983886624 | `af3e81a57059ecc77dde0561fff79128a1e151ab` | 137090598006 | `GitHub Actions 1000019600` | `success`     |

These controls show that the unchanged native path can reach and report its
real test outcome. They neither reproduce the interruption nor identify its
cause, and they are not treated as a rerun or proof that the original shutdown
was transient.

## Missing authority and recovery route

The repository-facing Actions APIs and logs do not expose the runner listener
diagnostic that received the control message, a cancellation initiator, a
control-plane cancellation record, host lifecycle or eviction telemetry, or a
runner service stop record. The organization audit-log endpoint was also not
available to this investigation (the API returned HTTP 404), so it supplies no
positive or negative cancellation evidence.

Because the termination source remains unresolved, the repository cannot
justify a code or workflow correction. If the shutdown recurs, the responsible
route is to retain the new run ID, job ID, runner identity, exact SHA, and full
log, then ask GitHub Support to correlate those records with hosted-runner
listener diagnostics, control-plane cancellation/audit records, and host
lifecycle telemetry. That support contact is a recovery route, not part of this
investigation. A future repository change is warranted only if that evidence
locates a repository-controlled boundary; it must preserve interruption and
assertion failures as non-success and validate the ordinary `utils` job on the
exact corrected SHA.
