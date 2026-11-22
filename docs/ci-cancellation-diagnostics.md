# CI cancellation and finalization diagnostics

The `tables-2` command uses the same bounded Linux supervisor as `tables-1`.
The scheduled CI Duration Monitor retains cancellation evidence separately from
its duration-based improvement issues. A cancelled result is not itself a failed
test, and a successful test command does not establish that the whole job finished.

## What the tables supervisor records

Both native shards keep `--project=tables --shard=1/2` or `--shard=2/2`, the
existing test selection, assertions and Playwright retries. The supervisor limits
the command to 1,200 seconds and the remaining portion of a 1,320-second budget
measured from execution-context initialization after checkout. A 10-second
termination grace allows owned descendants to exit before escalation. The GitHub
job limit remains 30 minutes.

The artifact named
`e2e-artifacts-chromium-tables-2-<run_id>-<run_attempt>` contains:

- `job_logs/execution-context.json`: run, attempt, shard, execution identity and
  checked-out GitHub SHA. This can be a pull-request merge SHA, rather than the
  workflow run's head SHA.
- `job_logs/tables-2-command-status.json`: command result, exit code, received
  signal when observed, process snapshots and any remaining owned processes.
- The command log, Playwright reports and test attachments that exist when the
  upload runs.

Timeout, interruption, incomplete reports and cleanup failures remain nonzero.
The upload is eligible after verified test entry for success, failure and
cancellation. Force cancellation, runner loss or expiration can still prevent
retrieval. Startup failures retain the existing safe diagnostic artifact; raw
startup service logs are not added to the test artifact. E2E artifacts are retained
for two days.

## Reading the monitor report

Run **CI Duration Monitor** manually on `main` with `dry_run=true`, or inspect its
scheduled run. Download `ci-duration-monitor-<run_id>-<run_attempt>` and read
`cancellation-diagnostics.md` or `cancellation-diagnostics.json`. The same data is
included in `report.json`; the step summary shows aggregate counts. Monitor
artifacts are retained for 14 days.

Each diagnostic uses `(run_id, run_attempt, job_id)` and the exact attempt's job
metadata. Failed-only reruns can copy a successful result into a later attempt
under a new job ID while keeping the original execution timestamps. The new ID
and `created_at` do not establish a new execution.

`job_outcomes` therefore separates `api_observations`, `current_attempt`,
`carried_forward` and `unknown`, each with its own `total` and `conclusions`.
Use **`current_attempt` counts** for cancellation rates and exclude carried or
unknown provenance. These counts identify job-result intervals, including early
cancellations and skipped results when their timestamps permit attribution; they
do not prove that the test command ran. `api_observations` is an API-record count
and can include the same result more than once.

A result completed before a rerun's `run_started_at` is retained separately in
`carried_forward_observations`. Its original attempt and job ID remain unknown;
the monitor does not guess an artifact's source attempt. Missing or inconsistent
intervals have unknown execution provenance. `observations` contains non-carried
failed, cancelled, timed-out and unresolved cases, preserving their cause and
finalization evidence independently of execution provenance.

`collection_complete=false` means collection stopped early: those counts are
partial, not a complete cancellation rate. The normal discovery window includes
runs **created** in the last 48 hours, not every run that happened to finish during
that interval.

| Field / evidence                                     | Interpretation                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub `job_conclusion`                              | The platform's final job result, distinct from the test command's result.                                                                    |
| `termination.category=job_timeout`                   | GitHub reports `timed_out` or its explicit maximum-job-execution-time annotation.                                                            |
| `termination.category=concurrency_cancelled`         | GitHub explicitly reports cancellation for a higher-priority waiting concurrency request.                                                    |
| `termination.category=unknown`                       | No supported explicit cause was available. Generic “operation was canceled” messages do not identify the initiator.                          |
| `termination.category=conflicting_evidence`          | More than one incompatible cause was reported; retain the evidence for investigation.                                                        |
| `concurrency.newer_same_branch_run_ids`              | Candidate overlap only. This does not prove a matching concurrency group or a cancellation initiator.                                        |
| `finalization.state=unresolved_after_job_completion` | The job is terminal, but `Complete job` has no terminal state/timestamp. This does not prove continuous cleanup activity or a runner defect. |
| Wrapper `status=timed_out`                           | The supervised command reached its own budget. GitHub may record the job as `failure`, rather than `cancelled`.                              |
| Wrapper `status=interrupted` / `received_signal`     | The supervisor received a signal. The signal alone does not distinguish manual cancellation from concurrency.                                |

The monitor does not download wrapper archives. `wrapper_evidence.state` remains
`not_collected`, artifact availability remains unknown, and the expected artifact
name is a lookup aid rather than proof that an archive exists. No expected name
is supplied for carried-forward or unknown execution provenance. Inspect the actual
archive before using its contents, and match run, attempt, shard and checked-out
SHA against `execution-context.json`. Run `actor` and `triggering_actor` identify
who triggered an execution, not who cancelled it. Missing timestamps remain null;
the job's completion time must not be substituted for a missing `Complete job`
completion time.

These diagnostics never qualify or create a duration-improvement issue. Existing
duration admission, provenance checks and publication/dry-run behavior remain
separate.

## Historical evidence motivating this change

The initial audit found eight cancelled `tables-2` jobs among 37 usable table-shard
observations. GitHub check annotations subsequently identified three job timeouts
and five concurrency cancellations. The original discovery sampled 50 completed
CI runs; 12 unavailable job responses were excluded and one remaining run had no
table-shard jobs. This is a bounded sample, not a long-term cancellation estimate.

| Run / job                                                                                                           | Explicit GitHub annotation                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [44992573289 / 137117141662](https://github.com/outliner-online/outliner/actions/runs/44992573289/job/137117141662) | Job exceeded 30-minute execution limit.                                                                       |
| [44987321523 / 137101021200](https://github.com/outliner-online/outliner/actions/runs/44987321523/job/137101021200) | Higher-priority waiting request for `ci-CI-refs/heads/main`.                                                  |
| [44985109844 / 137094191405](https://github.com/outliner-online/outliner/actions/runs/44985109844/job/137094191405) | Job exceeded 30-minute execution limit.                                                                       |
| [44950001639 / 136986117169](https://github.com/outliner-online/outliner/actions/runs/44950001639/job/136986117169) | Higher-priority waiting request for `ci-CI-refs/pull/6010/merge`.                                             |
| [44941366378 / 136960910609](https://github.com/outliner-online/outliner/actions/runs/44941366378/job/136960910609) | Higher-priority waiting request for `ci-CI-refs/pull/6009/merge`.                                             |
| [44934869517 / 136940530958](https://github.com/outliner-online/outliner/actions/runs/44934869517/job/136940530958) | Higher-priority waiting request for `ci-CI-refs/pull/6016/merge`.                                             |
| [44931926441 / 136930939312](https://github.com/outliner-online/outliner/actions/runs/44931926441/job/136930939312) | Higher-priority waiting request for `ci-CI-refs/pull/6009/merge`.                                             |
| [44930761504 / 136927285344](https://github.com/outliner-online/outliner/actions/runs/44930761504/job/136927285344) | Job exceeded 30-minute execution limit; `Complete job` remained `in_progress` without a completion timestamp. |

The last case demonstrates two separate observations: confirmed job timeout and
unresolved finalization metadata. Its test step ended with `failure`; without its
command log, that does not establish an assertion failure or its root cause.

## Verifying finalization after a change

1. Run the supervisor subprocess and real Playwright contract tests. These cover
   native shard selection, success, assertion failure, timeout with retained
   attachments, premature worker exit, budget exhaustion and descendant cleanup.
2. Inspect a CI attempt at the exact proposed commit. Record the real `tables-2`
   job URL, run attempt and job ID, command result, artifact-upload result,
   post-action states and `Complete job` timestamps.
3. Confirm that the job interval belongs to that attempt before downloading its
   archive, then match the archive's execution identity. A successful result
   copied into a failed-only rerun is evidence from its original execution, not
   proof that the shard reran. Do not combine copied job metadata with an assumed
   artifact from the later attempt.
4. If finalization is unresolved again, preserve the nullable step metadata and
   retrieve that job's annotations and logs. Investigate remaining owned processes
   only when the retained evidence supports it; do not introduce global process
   killing or speculative runner cleanup.

A successful real `tables-2` attempt establishes that this attempt finalized.
A forced timeout in the regression job establishes the supervisor's timeout
behavior. Neither observation by itself proves that every outer-job timeout or
runner failure will finalize successfully. Record stronger claims only when the
corresponding real failure path has been exercised.
