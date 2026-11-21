# CI duration review issues

The **CI Duration Monitor** runs daily at **21:43 UTC (06:43 JST)**. It retains
job, queue, command and longest-step timings, but creates an improvement issue
only for a recurring, verified test-work slowdown. Scheduled runs can start late.

## Automatic issue eligibility

All of these conditions must hold:

1. GitHub verifies the repository identity and current default branch SHA. The
   observed execution is a `push`, `schedule` or `workflow_dispatch` on that
   branch in that repository. Feature-branch and PR runs remain diagnostic.
2. The configured workflow is active at its exact path. Its current YAML declares
   the exact observed job/variant, including local reusable workflows and static
   matrix expansion. Workflow display names alone confer no authority. Dynamic
   matrices and unsupported matrix include/exclude rules remain diagnostic.
3. The configured native measurement adapter applies to the actual job's declared
   test step. The workflow chain and declared implementation source files at the
   observed SHA are byte-identical to the verified default-branch sources.
4. The job and matched test steps succeed with complete timings. Command elapsed
   time reaches **600 seconds** and at least half of runner execution. Setup,
   dependency acquisition, builds, failed startup, skipped tests, incomplete
   commands, queue time and workflow totals cannot qualify on their own.
5. A supported native report demonstrates at least **600 seconds of test work**
   in multiple test files. Native timings are separate from command elapsed time.
   Unknown formats, unavailable logs, retries, failures and skipped tests remain
   diagnostic. Summed native test durations can overlap under parallel execution;
   they describe work, not a predicted end-to-end saving or proof of a safe split.
6. At least **two distinct runs of the same job variant** meet these conditions.
   Different shards, retries and retained rows in later attempts do not establish
   recurrence. Every observed family member is evaluated, including a slow test
   job whose total is shorter than a sibling delayed by setup.

## Profiles and measurements

[`.github/ci-duration-monitor.json`](../.github/ci-duration-monitor.json) declares
families, exact entrypoints and the measurement adapter. The actual current
workflow inventory is an additional gate, not a regex fallback.

| Entrypoint                                                                            | Native measurement policy                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main CI and direct manual unit/integration workflows                                  | `vitest`: successful native test/file counts and the native `tests` duration, excluding transform/setup/collection/environment timings. Single-file summary blocks contribute no qualifying work. |
| Main CI and direct manual Chromium/Firefox E2E workflows                              | `playwright`: one complete passing list-reporter summary, matching individual native test timings across distinct spec files, without retries. Line-only or unrecognized output stays diagnostic. |
| On-premises Compose and schedule Hosting page/service contracts                       | The same `playwright` rule applies to their actual declared verification step; startup/build time inside a wrapper alone cannot qualify. A single spec remains diagnostic.                        |
| Server, canonical project-directory, devcontainer probe and container-tool validation | `diagnostic`: their current Mocha/probe/tool entrypoints do not expose the supported independent-file native timing format. Retain evidence until a verified measurement adapter is available.    |
| Unconfigured build, lint, guard or historical job variants                            | Diagnostic only; a fallback family preserves its exact job name and timings.                                                                                                                      |

Manual invocation is therefore eligible when it uses a supported current
entrypoint on the default branch and supplies recurring native evidence. There
is no blanket manual/support-workflow exclusion. Adding a future adapter must
include real reporter fixtures and actual entrypoint verification.

The original owner-closed examples remain diagnostic: Firefox dependency setup
failed after 700s without executing tests (#5998); Compose spent 376s installing
Playwright versus 268s in verification (#5999); the Hosting contracts spent 553s
and 595s acquiring dependencies versus 41s and 34s verifying (#6000/#6001). The
649s image build in #6003 belonged to an unsuccessful, retired PR prototype named
`Prepared runtime smoke (not E2E migration)`, absent from the current workflow.
These are not five independent recurring test-work optimizations. Cross-family
steps taking at least 300s are grouped as `shared_setup_diagnostics` when seen in
multiple families and runs. That grouping is retained evidence, never an issue.

## Discovery, closure and submission recovery

The default scan discovers completed runs **created in the preceding 48 hours**,
inspects every attempt and paginates jobs separately. The report retains unknown
queue times when GitHub supplies an out-of-order creation/start interval. The
original job completion remains authoritative; a retained attempt row is not a
new execution. Run search truncation fails explicitly.

The existing repository/workflow/family identity marker and
`ci-duration-monitor` label deduplicate open issues across overlapping scans.
Reviewer-edited bodies and consumed `review-ready` labels remain preserved.
New evidence is appended in comments. Creation, durable identity comment and
final `review-ready` submission remain separate operations; mutation failures
are never blindly retried.

Closed issues stay closed. A later issue requires **two new qualifying runs
completed after the latest closure**; identical later setup failures or retired
variants cannot recreate or reopen the closed issue. Genuinely new actionable
regressions remain eligible without permanent family suppression.

Only submissions carrying the new policy receipt for the currently verified
source SHA may recover readiness from retained evidence after runs age out.
Legacy total-duration submissions cannot bypass the eligibility gate. A source
change requires fresh qualification. Incomplete reviewer-edited specifications
still withhold readiness. The repository must already provide `review-ready`.
The monitor may create its own managed label after qualification.

## Running and inspecting

In Actions, choose **CI Duration Monitor → Run workflow** on the default branch.
`dry_run` defaults to `true`; only explicitly publishing invocations and scheduled
runs can mutate issues. Pull-request/push executions run regression verification.
Scheduled/manual reconciliation is serialized by the existing concurrency group.

For a read-only local scan:

```bash
python -m pip install loguru==0.7.3 PyYAML==6.0.3
python scripts/ci_duration_monitor.py \
    --repository outliner-online/outliner \
    --config .github/ci-duration-monitor.json
```

`--source-ref` is retained for CLI compatibility; source links always use the
GitHub-verified default SHA. `--lookback-hours N` extends discovery for recovery.
`--output-dir PATH` chooses the report/log destination. Add `--publish` only when
issue publication is intended. The existing token permissions remain
`contents: read`, `actions: read`, `issues: write`; regression jobs are read-only.
`GITHUB_API_URL` selects the REST endpoint. Native logs are read through the same
transport and never copied into issue bodies.

Reports and logs go to `ci-duration-monitor-output/` and Actions retains them for
14 days. `report.json` includes verification provenance, per-sample diagnostic
reasons, native timings and shared setup evidence. The summary lists actions and
workflow-only delays. Transient GET failures receive bounded retries; unresolved
API failures fail the monitor before it claims successful submission.

## Focused verification

```bash
python -m unittest discover -s scripts/tests -p 'test_ci_duration_monitor*.py' -v
```

The tests use an isolated GitHub stub and a real local HTTP fixture server. They
cover the five native owner-closed step shapes, repeat scans, closure and fresh
regressions, branch/repository/source/variant negatives, manual supported tests,
recurrence, native timing formats, pagination, interrupted submission and retained
recovery. Verification does not create or change live GitHub issues.
