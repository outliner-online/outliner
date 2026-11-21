# CI duration review issues

The daily workflow runs at **21:43 UTC (06:43 JST)**. Qualification uses GitHub's
native job/step `started_at`, `completed_at`, `status` and `conclusion` fields.
There is no log parsing, reporter instrumentation, JSON test-result admission,
percentage conversion, per-file timing requirement or two-run admission barrier.
The monitor does not implement sharding.

## Admission before existing duplicate handling

A candidate needs all of the following:

1. Verified repository/default-branch metadata and an active workflow at its
   exact configured path. Its current YAML, local reusable workflow chain and
   static matrix declare the exact job variant and execution step names.
2. Either a default-branch push/manual/scheduled execution, or a same-repository
   PR run with GitHub-native PR/base repository identities targeting the default
   branch. Workflow/entrypoint source bytes at the immutable observed SHA must
   match the verified default branch. A matching display name alone is not proof.
3. A configured, reviewed **separated execution contract**. All matching exact
   test steps must complete successfully, with usable intervals inside the job.
   Their total execution must reach **600 seconds** and at least half of the job's
   runner execution. Setup, acquisition, build, queue time and workflow totals
   cannot qualify a family on their own.

Normal retries remain part of the successful test execution step. A successful
Playwright retry does not erase a genuine ten-minute test process. Step elapsed
time includes the normal test harness and fixtures; it is not claimed as pure
individual test-body time or a prediction of sharding savings.

`report.json` exposes `admission` and `admission_summary` before existing issue
reconciliation: qualifying candidate job IDs, matching open issues, families
that qualify with an existing issue, new qualifying families, and insufficient
or diagnostic evidence. **Insufficient evidence is not reported as duplication.**
The existing repository/workflow/family identity, open-issue lookup, evidence
markers, reviewer-body preservation, consumed readiness and closure checks remain
unchanged. Already recorded queued evidence remains unchanged; new evidence follows
existing reconciliation. Closed issues stay closed unless later qualifying
execution satisfies the existing post-closure rule.

## Actual execution boundaries

| Family                                                       | Execution boundary                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                                                         | Existing `Setup Test Environment`, then `Run unit tests`: the existing package command runs both unit Vitest and base-path Vitest verification. No command or selection changes.                                                                                                                                                                                                 |
| Integration                                                  | Existing setup, then the existing `Run integration tests` Vitest command.                                                                                                                                                                                                                                                                                                        |
| Server                                                       | Existing setup plus `Prepare server test runtime` runs the exact former `SKIP_SERVER_START=1 SKIP_PORT_WAIT=1 bash scripts/setup.sh` with the original environment. `Run server tests` invokes `npm run test:prepared`, retaining npm’s executable PATH/context for the prepared Mocha command, with the same loaders, exclusions, timeout, `--exit`, pipefail and log pipeline. |
| Canonical project directory                                  | Existing setup, then the existing explicit four-file Mocha command.                                                                                                                                                                                                                                                                                                              |
| Chromium/Firefox E2E                                         | Existing dependency setup/build/startup, then exact `Run E2E tests (variant)`. This includes current `new-4`, `new-3a` and `new-3b`; reporter format is irrelevant. The `onprem` matrix variant still builds production output inside its wrapper and remains diagnostic.                                                                                                        |
| Compose, Hosting wrappers, devcontainer and container guards | Diagnostic until their own acquisition/preflight can be verified as separated from execution. Unknown fallback jobs remain diagnostic.                                                                                                                                                                                                                                           |

`npm test` in `server` retains its local default: perform the same preparation,
then execute the same Mocha selection. The CI-only prepared command is factored
into `scripts/run-server-test-command.sh`; it does not replace preparation with
trust in `.setup-installed`. The prepared path verifies local Mocha and ts-node prerequisites and fails rather
than allowing npx to acquire a missing runner inside the timed execution.
Generic setup can still install, build, stop PM2/
emulators and wait even when a sentinel exists, so that work is explicitly timed
outside the CI test step. Required checks, retries, job timeouts and topology are
preserved. No full test suite is added or repeated.

## Owner evidence and historical limits

GitHub job `136798530012`, run `44885392240`, attempt 2, reports new-4 success:
**1,090 job seconds**, **1,003 test-step seconds**, 43 dependency seconds and 28
startup seconds. The actual test command ran about 08:36:15.684–08:52:58.233 UTC;
its one legitimate retry remains inside the measured execution. This is an
eligible execution candidate before lookup of existing Chromium issue #5997.
Unit job `136731411619` reports **887 job / 721 execution seconds**, with setup
already separated. Server job `136731411435` reports **965 / 802 seconds**, but
its historical wrapper included nested generic preparation: that historical
802 seconds is not retroactively relabeled as pure Mocha time. Forward server
measurement is trustworthy only with the reviewed separated preparation contract.
The exact measured API rows are regression fixtures for the current contract.

The closed false positives remain diagnostic: #5998 failed dependency setup
without tests; #5999 spent 376s installing Playwright versus 268s verifying;
#6000/#6001 spent 553s/595s acquiring dependencies versus 41s/34s verifying;
#6003 was a retired PR prototype with a 649s image build. Setup timing is retained,
including shared cross-family setup groups, without creating per-family issues.

A read-only scan before this change merges cannot certify the new server helper
as default-branch source. Its historical mixed boundary remains explicit
insufficient evidence. Existing queued #5995/#5996/#5997 are not modified by
verification, and an admission count of zero must never be called merely a
successful duplicate check.

## Operation and verification

Default discovery covers completed runs created in the prior 48 hours, with
attempt-specific paginated jobs. Old retained job completion timestamps remain
authoritative. Incomplete pagination, auth, source or workflow metadata fails
closed before writes. No log/artifact endpoint is needed for qualification.

Manual invocation defaults to dry-run. Pull requests/pushes run verification;
publication remains confined to the existing authorized workflow events and
permissions. Mutations are never blindly retried. Interrupted valid submissions
retain their complete-body/identity/final-readiness sequence; only a current
separated-step policy receipt can recover a retained submission without new data.

```bash
python -m pip install loguru==0.7.3 PyYAML==6.0.3
python scripts/ci_duration_monitor.py --repository outliner-online/outliner
python -m unittest discover -s scripts/tests -p 'test_ci_duration_monitor*.py' -v
# With the existing server dependencies installed:
python -m unittest discover -s scripts/tests -p 'test_server_test_boundary.py' -v
```

The CLI is read-only without `--publish`; `--lookback-hours` and `--output-dir`
control discovery and reports. Tests use isolated GitHub/HTTP boundaries and
small real Mocha fixtures to check selection, failure exit and setup parity.
They never change live issues. Reports/logs are retained by the existing Actions
artifact step for 14 days; logs contain metadata identifiers, not signed log URLs.
