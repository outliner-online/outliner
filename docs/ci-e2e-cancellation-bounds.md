# E2E cancellation bounds and heartbeat evidence

A cancelled command must remain non-success, release its owned processes, and
leave time to retain evidence. These controls improve the live-runner path;
they do not claim to identify or eliminate the underlying cause of every
GitHub-hosted runner interruption.

## Supervised commands

The primary Chromium commands for new-2-1, new-2-2, new-3a, new-3b, tables-1
and tables-2 use `scripts/ci/run-bounded-e2e.py`. Their Bash branches replace
the step entry process with `exec python3`. This lets a cancellation signal
reach the supervisor directly while retaining the actual npm, dotenvx,
Playwright and browser process tree.

The supervisor keeps its Linux child-subreaper ownership. Detached descendants
are included; unrelated services and sibling processes are not signalled.
Startup still uses its existing structured, allowlisted evidence and successful
service handoff.

## Heartbeats and lifecycle evidence

The test supervisor uses Loguru to write the same JSON event to a file and a
nonblocking stdout sink. The separate
`job_logs/<project>-command-status.supervisor.jsonl` file is included in the
existing artifact paths. The raw command log remains separate and complete,
even when the Actions console cannot keep up.

Events record command start, a heartbeat every 30 seconds, received signals,
cleanup escalation, report validation and completion. They include run,
attempt, shard and checkout identity, elapsed time, remaining command budget,
child output byte count and time since output last changed, and numeric
snapshots of owned processes. Process snapshots contain PID, parent PID, state,
CPU seconds and resident memory; they exclude command lines, environment
variables and raw child output. The per-event process list is capped at 64.

`output_idle_seconds` measures changes to the child log, not test completion.
A heartbeat proves that the supervisor reached its loop, not that a test is
making progress. `live_cpu_seconds` sums CPU time for currently observed
descendants and can decrease when processes exit. `summed_rss_bytes` can
double-count shared pages; it is not unique physical-memory consumption.
The command-status JSON retains the latest heartbeat and phase, while JSONL
preserves the transition history. Existing line-reporter output identifies
the last started test.

Both command and diagnostic console writes are nonblocking. Dropped console
bytes are accounted for, and file evidence remains available. Logging does
not extend the execution budget or convert missing reports into success.
A `validating_report` event precedes synchronous report validation, making
that boundary distinguishable from a test that never exited.

## Cancellation and time limits

| Boundary                                                              | Limit                                                                             | Result                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Supervised primary test command                                       | 1,200 seconds, also capped at 1,320 seconds from execution-context initialization | Timeout remains exit 124                                         |
| Internal timeout or orphan cleanup                                    | Existing 10-second TERM grace, followed by bounded KILL/reaping                   | Failure remains nonzero                                          |
| External SIGINT or SIGTERM                                            | At most 2-second TERM grace and a shared 2-second reaping allowance               | First signal determines exit 130 or 143 after successful cleanup |
| Later external signal                                                 | Immediate KILL escalation without renewing the deadline                           | Original signal identity is retained                             |
| E2E test step, including other matrix selections                      | 23 minutes from step start                                                        | Runner-side timeout remains non-success                          |
| Failure summary, startup-evidence verification, execution-status step | 1 minute each                                                                     | A stuck finalizer cannot consume the whole job                   |
| Execution-status command                                              | Existing 30 seconds plus 5-second forced-kill allowance                           | The shorter command bound is retained                            |
| Primary or safe-startup artifact upload                               | 3 minutes each                                                                    | Upload failure remains visible                                   |
| E2E matrix job                                                        | Existing 45 minutes                                                               | Leaves room for setup and evidence retention                     |

An external signal also shortens cleanup that already began after an internal
timeout. Repeated signals never restart the grace period. The stopping loop
and exceptional-exit cleanup share an absolute deadline instead of adding
successive full waits.

GitHub's [workflow cancellation reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
describes SIGINT to the step entry process, a 7.5-second wait, then SIGTERM and
a further 2.5-second wait. The independent
[step timeout](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepstimeout-minutes)
adds a runner-side boundary if the supervisor no longer reaches its own
deadline checks. A lost runner, uninterruptible kernel I/O or a delayed
GitHub control plane can still prevent timely UI finalization or artifact
upload. The 23-minute setting is not a promise that GitHub will display a
terminal job state within 23 minutes.

## Verification

The regression suite executes real processes and real Playwright commands.
It covers quiet and noisy children, a full undrained console pipe, both
external signals, detached TERM-ignoring descendants, cancellation during an
existing timeout grace, and repeated-signal escalation. An unrelated process
must survive. Successful completion still requires a fresh, complete passing
Playwright report and existing attachment evidence.

The workflow cancellation test executes the shipped Bash step, startup
evidence verifier and actual npm/dotenvx/Playwright entry path in an isolated
fixture. It signals the original step PID and checks that cancellation stays
nonzero and owned descendants disappear before GitHub's initial escalation
window. A positive control must execute and pass a real Playwright test.
The existing startup, native-shard selection, artifact and failure-propagation
regressions remain in the selection-coverage CI job.

For local execution, install the existing script dependencies, make the client
Playwright dependencies available, and run:

```bash
python3 -m pip install -r scripts/requirements.txt
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover   -s scripts/tests -p 'test_bounded_e2e*.py' -v
```

No automatic rerun or external force-cancel policy is introduced. Required
check names, native test selection, assertions, retries, artifact identities
and concurrency cancellation remain unchanged.
