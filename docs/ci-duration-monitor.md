# CI duration review issues

The **CI Duration Monitor** workflow runs daily at **21:43 UTC (06:43 JST)**.
It reads completed GitHub Actions attempts and submits an English improvement
issue when a job's runner execution reaches **600 seconds or more**. GitHub may
start a scheduled workflow later than its cron time.

## What the monitor measures

The threshold is `completed_at - started_at` for an actual job, including its
setup, test commands and cleanup. Runner queue time is reported separately and
does not contribute to the threshold. Successful, failed and timed-out completed
jobs can supply evidence; cancelled, skipped and unfinished jobs do not.

The default scan discovers runs **created during the preceding 48 hours**, which
overlaps consecutive daily scans. Each run attempt is inspected separately, and
paginated jobs are read from that attempt. GitHub can retain an earlier successful
job's execution timestamps in a later attempt view while giving that row a newer
creation timestamp; its queue duration is unknown rather than negative or zero.
Such an attempt row is not evidence of a fresh execution, and the original job
completion timestamp remains the authority for whether an observation is newer
than an issue's closure. Detection considers every eligible observation in the scan window. Issue evidence
shows the latest five observations per logical family, plus an older qualifying
observation when needed to explain the trigger. A qualifying observation opens an
issue without requiring multiple slow days.

A workflow's total time can exceed ten minutes because of dependency ordering,
queueing or aggregation even when its individual jobs remain shorter. Those
workflow totals remain diagnostic evidence; they do not create job-splitting
issues by themselves. Missing timestamps remain unknown.

The test-command step duration is an indicator for investigation. It can include
fixture setup, retries and harness work inside the command. It is not a native
pytest, Mocha, Vitest or Playwright phase measurement. The issue asks reviewers to
inspect native durations and distinguish test work from dependency acquisition
before choosing a split or setup optimization.

## Monitored workflows and job families

[`.github/ci-duration-monitor.json`](../.github/ci-duration-monitor.json) is the
explicit monitoring configuration. It includes the main `CI` workflow, manually
invoked unit/integration/server/E2E workflows, on-premises Compose tests,
devcontainer Firebase smoke, test-container validation, and both schedule Hosting
contract workflows. Deployment, image publication and the monitor itself are
outside this configuration.

The main workflow invokes reusable test workflows, so GitHub names jobs such as
`unit-test / unit-test` and `e2e-test / e2e-test (new-2-1)`. The configuration
recognizes these names as well as direct manual runs. Chromium E2E shards share
one family, while Firefox E2E shards have a separate family. The existing
`new-2`, `new-3` and `tables` partitions therefore do not each create duplicate
issues for the same browser suite. Unit, integration, server and canonical
project-directory tests remain separate.

Other job names in a monitored workflow use their exact name as a fallback
family. Independent build, lint and guard jobs consequently retain independent
issues. Add explicit family expressions only for jobs that really share one
bounded test or work selection. Review both the job expression and the
`test_step_pattern`: a build step named "Build test image" is still a build.

## Issue handoff and recovery

The monitor uses the `ci-duration-monitor` label plus durable hidden identity and
evidence markers. The identity includes the repository, workflow and logical
family. Overlapping scans reuse an open issue instead of creating another issue
for each shard or rerun. New evidence is added in comments, preserving the
reviewers' issue body, Objective and Requirements.

A new issue is created with its complete body, then receives a durable identity
comment, and **`review-ready` is added in a separate final submission operation**.
The repository must already provide that readiness label. The monitor can create
its own `ci-duration-monitor` label when needed. Readiness is not attached to a
partially created specification.

If publication is interrupted, the next scan reconciles the existing issue and
comments before continuing. An unfinished submission can recover from its retained
complete specification and evidence even after the original run ages out of the
48-hour discovery window. If reviewers have changed an unfinished issue into an
incomplete specification, the monitor withholds `review-ready` until that
specification is complete. A lost response does not authorize blindly repeating
an issue creation. A previously applied `review-ready` label is recognized from
the issue events even if reviewers have since removed it; the monitor does not
put a consumed label back. A closed issue is retained, and only new qualifying
observations completed after its closure can start another issue for that family.

Each generated issue contains a short Objective, observed run/attempt/job links,
job and queue timings, slow-step evidence, numbered Requirements, acceptance
scenarios and a repository-grounded initial implementation prompt. The requested
follow-up preserves the full test selection, browser coverage, native failures
and existing validation gates. The monitor does not modify shard counts or CI
timeouts itself.

`review-ready` is the requested handoff signal. Issues created with the workflow's
`GITHUB_TOKEN` do not normally trigger another Actions workflow through an
`issues` event. A consumer must observe the submitted issues through its existing
polling or other supported intake; this workflow does not provision an external
reviewer or claim that it has completed a review.

## Running and inspecting the monitor

In Actions, select **CI Duration Monitor → Run workflow** on the default branch.
The `dry_run` input defaults to `true`: it collects the same evidence and planned
issue actions without mutations. Select `false` to publish. Pull-request and
push executions only run the monitor's focused regression tests; they do not
publish issues. Scheduled and manual runs share a non-cancelling concurrency
group so their issue reconciliation is serialized.

For a local read-only inspection, supply `GITHUB_TOKEN` through your existing
authenticated environment and run:

```bash
python -m pip install loguru==0.7.3
python scripts/ci_duration_monitor.py \
    --repository outliner-online/outliner \
    --config .github/ci-duration-monitor.json \
    --source-ref "$(git rev-parse HEAD)"
```

Add `--publish` only when issue publication is intended. The GitHub Actions token
has `contents: read`, `actions: read` and `issues: write` for the monitor job;
regression checks use read-only repository permissions. The transport uses the
Actions `GITHUB_API_URL` when provided, otherwise GitHub's public REST API.

The CLI also accepts `--lookback-hours N` for a longer recovery scan and
`--output-dir PATH` for diagnostic output. The workflow uses the 48-hour default;
there is no lookback input in the manual Actions form. Runs originally created
before the lookback are not discovered even when an old run is retried recently.
Use a longer CLI lookback when recovering such attempts. If a run search reaches
GitHub's result limit, the monitor fails explicitly rather than reporting a
partial scan as complete.

Reports, summaries and Loguru logs are written under
`ci-duration-monitor-output/`, and logs also go to standard output. Actions
retains this directory as an artifact for 14 days, including failure diagnostics.
The summary shows planned or performed issue actions and workflow-only delays.
Transient read-only API failures receive bounded retries. Mutations are never
blindly retried: a failed issue mutation or readiness-label operation, or an API
read that still fails after its retry allowance, fails the job rather than being
reported as successful submission.

## Focused verification

```bash
python -m unittest discover -s scripts/tests -p 'test_ci_duration_monitor*.py' -v
```

The shared regression suite covers threshold boundaries, attempts and pagination,
duplicate suppression, publication interruption and reviewer handoff. Repository
regressions verify the actual configured job families and real HTTP request
serialization against an isolated local fixture server. They do not contact or
mutate GitHub issues.
