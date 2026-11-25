# Chromium E2E cancellation investigation (#6049)

## Conclusion

GitHub's check-run annotations identify the cancellation boundary in both the
affected main jobs and the same-name pull-request jobs: each job exceeded its
configured 30-minute maximum execution time. The native job records show that
setup, the server build, and service startup completed before the test step;
they do not show which test was last active or why its Playwright process did
not finish. Elapsed job time alone was not used to attribute the cancellation.

The original retained evidence establishes the outer job deadline as the
cancellation authority, but it does not establish a shared
repository-controlled stall inside the test step. A subsequent ordinary hosted
Chromium execution on this investigation's pull request exposed a separate,
repeatable repository boundary after the test step: execution-status recording
remained active until the outer job deadline and prevented artifact and
post-action steps from running. Status recording is now bounded to 30 seconds
and remains non-success if it cannot finish. The correction does not change
job timeouts, concurrency, retries, required-check identities, test selection,
artifact identity, failure propagation, or deployment prerequisites.

## Affected main execution

The affected execution was the `push` event for main commit
`87dd58259dd68ffb5f559a99a79ad47923b6a45e`: [CI run 45624726603, attempt 1](https://github.com/outliner-online/outliner/actions/runs/45624726603/attempts/1).
The run API records `kitamura-tetsuo` as actor and triggering actor. Those
fields identify who started the run, not a separate cancellation initiator.
The affected native job records are:

| Shard      | Job                                                                                                   | Job interval (UTC) | Setup boundary                                                                                     | Test boundary                                            | Native conclusion |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| `new-3b`   | [139243031968](https://github.com/outliner-online/outliner/actions/runs/45624726603/job/139243031968) | 13:35:11–14:10:12  | dependencies 13:35:21–13:37:02; build 13:37:02–13:37:06; startup 13:37:06–13:37:27, all successful | began 13:37:27; no terminal step timestamp or conclusion | `cancelled`       |
| `tables-2` | [139243032217](https://github.com/outliner-online/outliner/actions/runs/45624726603/job/139243032217) | 13:35:12–14:10:12  | dependencies 13:35:25–13:37:10; build 13:37:10–13:37:15; startup 13:37:15–13:37:37, all successful | began 13:37:37; no terminal step timestamp or conclusion | `cancelled`       |

For each job, the check-run annotations endpoint returns the explicit failure
annotation `The job has exceeded the maximum execution time of 30m0s`. This is
positive deadline evidence, rather than an inference from the roughly
35-minute native job interval. The job API leaves the test step `in_progress`
with no completion timestamp and leaves later reporting, artifact, post-action,
and complete-job steps pending. No matching `new-3b` or `tables-2` artifact is
available from the run inventory, so no wrapper status, Playwright report,
command log, last test progress, or owned-process snapshot can be recovered
from repository-visible retained evidence.

The outer workflow used concurrency group
<code v-pre>ci-${{ github.workflow }}-${{ github.ref }}</code> and the reusable
E2E workflow used
<code v-pre>e2e-${{ github.workflow }}-${{ github.ref }}</code>, both with
`cancel-in-progress: true`. No newer main CI execution was present in the
queried run window. More importantly, neither affected annotation reports a
higher-priority concurrency request: both explicitly report the job deadline.

## Successful sibling comparison

The same attempt's [core-1 job 139243031435](https://github.com/outliner-online/outliner/actions/runs/45624726603/job/139243031435)
used the same hosted-runner workflow path. Dependencies, build, and startup
completed by 13:37:23 UTC; its test step then completed successfully from
13:37:23 to 13:40:19, followed by evidence recording and post-actions, and the
job completed successfully at 13:40:45. The [new-3a sibling 139243031715](https://github.com/outliner-online/outliner/actions/runs/45624726603/job/139243031715)
similarly completed setup and startup by 13:37:36, finished its test step at
13:39:38, uploaded its artifact, and completed successfully at 13:39:57.

Those controls establish that sibling jobs could traverse the same setup,
startup, test, evidence, and finalization boundaries in that attempt. They do
not identify what blocked either affected selection or prove that a later green
run repaired the original condition.

## Same-name pull-request evidence

The earlier comparison is [#6039 CI run 45400874999, attempt 1](https://github.com/outliner-online/outliner/actions/runs/45400874999/attempts/1)
at head `70ecb6fd0b87d11d2a267851d44e19bea50d4101`. Its check-run annotations
give the same explicit 30-minute maximum-execution-time cause for all three
cancelled jobs:

| Shard      | Job                                                                                                   | Test-step evidence                                                      | Finalization evidence                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `new-3b`   | [138469989716](https://github.com/outliner-online/outliner/actions/runs/45400874999/job/138469989716) | startup succeeded; tests began 13:15:54 UTC and have no terminal result | job cancelled at 13:48:34                                                   |
| `tables-2` | [138469989805](https://github.com/outliner-online/outliner/actions/runs/45400874999/job/138469989805) | startup succeeded; tests began 13:15:59 UTC and have no terminal result | job cancelled at 13:48:34                                                   |
| `new-4-2`  | [138469989757](https://github.com/outliner-online/outliner/actions/runs/45400874999/job/138469989757) | startup succeeded; tests failed at 13:18:03 UTC                         | `Complete job` remained in progress until the job was cancelled at 13:48:34 |

The successful [core-1 sibling 138469989787](https://github.com/outliner-online/outliner/actions/runs/45400874999/job/138469989787)
finished its test step at 13:19:31 and its complete-job step at 13:19:51. The
`new-4-2` record is a distinct finalization case and cannot establish the cause
of the two unfinished test commands. The repeated timeout annotation aligns
the platform boundary across both runs, while the missing logs and artifacts
leave the internal blocking boundary unknown.

## Downstream checks and deployment

The two cancelled main matrix jobs are the missing test evidence. They are
separate from [new-2 gate 139264264415](https://github.com/outliner-online/outliner/actions/runs/45624726603/job/139264264415)
and [new-3 gate 139264264468](https://github.com/outliner-online/outliner/actions/runs/45624726603/job/139264264468),
whose `Require complete E2E matrix` steps failed only after the matrix jobs
ended. Those gate failures correctly rejected incomplete evidence; they did not
cancel the producers and are not test assertion failures. The skipped deploy
therefore preserved the existing automatic-deploy precondition rather than
treating absent results as success.

## Unavailable evidence and recovery route

The native job/check APIs do not retain a last Playwright case, process state,
runner listener log, or command-wrapper result for these jobs, and the run has
no corresponding retained artifacts. The available records consequently
cannot distinguish a hung test, browser/worker loss, repository service wait,
or another silent child-process condition. GitHub Support could supply hosted
runner and control-plane telemetry, while a recurrence with retained wrapper
artifacts could supply the repository-side command log, status, last progress,
and process snapshot.

For a recurrence, retain the exact run attempt, job IDs, runner identities,
check annotations, logs, and matching run/attempt/shard/SHA artifacts before
retention expires. Escalate the IDs to GitHub Support for runner-side evidence
and inspect the wrapper evidence for a reproducible repository boundary. A
repository correction is justified only if that evidence demonstrates the
shared defect; it must keep normal completion evidence and ensure a matched
failure or interruption remains non-success through the aggregate and deploy
gates, followed by ordinary hosted Chromium verification on the corrected SHA.

## Repository-controlled finalization correction

The first hosted run of this investigation supplied evidence that was not
available in the historical records. In [PR run 45678082056, tables-2 job
139432333398](https://github.com/outliner-online/outliner/actions/runs/45678082056/job/139432333398),
setup and startup succeeded, and `Run E2E tests (tables-2)` reached a terminal
`cancelled` result at 18:53:53 UTC. `Record setup and execution status` started
at that same instant but never received a terminal timestamp. Artifact upload
and both post-actions remained pending until GitHub cancelled the job at
19:43:17 with the explicit annotation `The job has exceeded the maximum
execution time of 45m0s`.

That sequence demonstrates a repository-controlled finalization stall at the
status-recording step independently of the test outcome. The workflow now runs
the extracted status recorder under a 30-second GNU `timeout`, with shell
`pipefail` preserving timeout or recorder failure as non-success. A normal
control verifies that the actual recorder writes the terminal job and test
outcomes; a matched blocked-input control verifies that the same recorder is
terminated with exit 124 rather than consuming the remaining job lifetime.
This boundary does not explain the historical unfinished Playwright commands,
and the correction makes no such root-cause claim.
