# Firefox startup interruption investigation (#6047)

## Conclusion

Repository-visible evidence does not identify who or what sent the shutdown to
the hosted runner. The affected Firefox job completed dependency setup,
launched the expected Firefox runtime, and built the server. Its service-startup
step had run for less than two seconds when the runner reported a shutdown; the
Playwright step never started. The run, job, check, log, workflow, concurrent-run,
and organization-audit evidence available to the repository does not establish
a repository-controlled interruption, a deliberate cancellation, or a hosted
runner fault.

No repository correction is justified. This investigation therefore leaves the
startup boundary, Firefox selection, required checks, timeouts, and deployment
preconditions unchanged. The native job and its downstream completeness gates
remained failures, and deployment remained skipped; the missing test invocation
was not reported as success.

## Affected native execution

The affected execution was the `push` event for main commit
`741da166b8750a6566bd371d327fffcd2eff7242`: [CI run 45583029498, attempt 1,
job 139098818605](https://github.com/outliner-online/outliner/actions/runs/45583029498/job/139098818605).
The run API identifies `.github/workflows/ci.yml`, actor and triggering actor
`kitamura-tetsuo`, and a start at 2026-11-25 09:11:24 UTC. Actor fields identify
who caused the push run; they do not identify a later runner shutdown.

The job API records:

- name `e2e-test / e2e-test (firefox-selection-core-4)`;
- runner `GitHub Actions 1000031299`, runner group `GitHub Actions`, and label
  `ubuntu-latest`;
- start at 09:16:46 UTC, completion at 09:18:06 UTC, and native conclusion
  `failure`;
- successful dependency setup through 09:17:55 UTC and successful server build
  through 09:18:03 UTC;
- cancelled `Run E2E-specific startup (services + readiness)` from 09:18:03 to
  09:18:05 UTC; and
- skipped `Run E2E tests (firefox-selection-core-4)` and all subsequent evidence
  and artifact steps.

The setup log is more specific about the boundary. It records a successful
headless Firefox 159.0 launch with Playwright 1.65.1 at 09:17:55.938 UTC,
`Direct-runner stage: ready` at 09:17:55.947, and
`stage=ready exit=0 elapsed=36s aggregate-budget=600s` at 09:17:55.951. The
server build then succeeded. The startup command
`bash scripts/ci/run-e2e-startup.sh` began at 09:18:03.099. At
09:18:04.915 the runner emitted `The runner has received a shutdown signal`,
and at 09:18:05.009 it emitted `The operation was canceled`.

The check-run API contributes one failure annotation, `The operation was
canceled.` It does not name an initiator. These records establish that a
runner-received shutdown interrupted service startup and prevented Playwright
from running. They do not establish that Firefox, dependency acquisition, the
server build, a test assertion, or repository cleanup caused the shutdown.

## Workflow and revision boundary

The outer workflow used concurrency group
<code v-pre>ci-${{ github.workflow }}-${{ github.ref }}</code> with
`cancel-in-progress: true`. The reusable E2E workflow used
<code v-pre>e2e-${{ github.workflow }}-${{ github.ref }}</code> with the same
setting. Its matrix had `fail-fast: false`, selected
`firefox-selection-core-4` as an ordinary Firefox shard, and retained the
30-minute job deadline.

The startup step runs `scripts/ci/run-e2e-startup.sh`; only after that succeeds
does the test step require successful startup evidence and invoke
`scripts/run-firefox-selection.mjs`. The interruption happened about two
seconds into startup, far before either the startup wrapper's 360-second bound
or the job deadline. There is no wrapper completion, readiness success,
repository timeout, or repository-issued termination record before the
runner-originated message.

Commit `741da166...` changed the bounded Ubuntu mirror acquisition implementation
and its tests. It did not change `.github/workflows/ci.yml`,
`.github/workflows/ci-test-e2e.yml`, `scripts/ci/run-e2e-startup.sh`, or
`scripts/ci-e2e-start.sh`; those four files are byte-for-byte identical to the
preceding main commit `c8e72ab142d3b947d93caabcc263e4c7d118234a`. The changed
acquisition path also completed successfully in the affected job before the
server build and startup boundary. Neither chronology nor the diff demonstrates
a repository-controlled shutdown.

## Same-run and preceding-run controls

Other jobs from the exact run continued through and after the shutdown. The
Chromium `core-4` job started at 09:16:53 UTC and passed at 09:19:47. The other
three Firefox selections also passed: `firefox-selection-core-4b` at 09:20:31,
`firefox-selection-basic` at 09:20:41, and `firefox-selection-new` at 09:21:51.
The direct-runner acquisition regression continued until 09:28:04, and later
matrix jobs continued until 09:36:13. These independent hosted runners show
that the run was not globally cancelled at 09:18:04; they cannot identify why
runner `1000031299` stopped.

The immediately preceding main CI run, 45568829951 for `c8e72ab...`, had
completed at 07:49:47 UTC, more than an hour before the affected run began. Its
[same Firefox shard, job 139052344538](https://github.com/outliner-online/outliner/actions/runs/45568829951/job/139052344538),
used the identical workflow and startup files. It reached direct-runner ready,
completed service readiness, invoked Playwright, and reported all 26 selected
tests passed. The other three Firefox selections also passed in that run. This
is a native control showing the unchanged path can reach and truthfully report
actual Firefox tests; it is not a rerun and does not explain the later shutdown.

No newer `main` CI run existed when the signal arrived. The preceding run had
already completed, and the next `main` push CI run was not created until
13:33:01 UTC. Thus the observable run list contains no competing same-workflow,
same-ref execution that could have invoked either configured
`cancel-in-progress` policy at 09:18:04. Absence from this list is not proof that
the Actions control plane or host lifecycle did not stop the runner.

## Independent downstream results

The later `e2e-test (new-3)` job 139110907555 and `e2e-test (new-2)` job
139110907836 are completeness gates. Each started at 09:36:16 UTC and failed
because the shared matrix result was not successful. They are downstream
consequences of the native shard failure, not additional startup interruptions
and not evidence about its initiator.

The artifact round-trip job 139098817569 succeeded at 09:14:10 UTC on the same
revision, before the Firefox interruption. It neither failed nor explains this
shutdown. The workflow-run-triggered [Deploy run
45587037795](https://github.com/outliner-online/outliner/actions/runs/45587037795)
was subsequently skipped for the same SHA, preserving the existing deployment
precondition.

## Comparison with #6040

The earlier [utils investigation](./ci-utils-startup-interruption-6040.md)
records the same observable class of event on a different revision and runner:
dependency setup and server build succeeded, service startup had run for about
two seconds, the runner reported a shutdown, and Playwright never began. Both
jobs used GitHub-hosted `ubuntu-latest` runners and both correctly concluded
`failure` while other matrix jobs continued.

The recurrence is useful correlation, not causal authority. The earlier event
was the `utils` shard on commit `7f95019a...`, runner `1000028278`, on November
24; this event was a Firefox shard on commit `741da166...`, runner `1000031299`,
on November 25. Neither repository-visible record supplies a cancellation
initiator, listener diagnostic, service-stop record, or host lifecycle event.
Two similar generic shutdown messages do not prove a common repository defect
or a common infrastructure cause.

## Missing authority and recovery route

The repository-facing Actions APIs expose the run, job, steps, check annotation,
and job log, but not the hosted runner listener's control-message source,
control-plane cancellation initiator, runner service-stop reason, or host
lifecycle and eviction telemetry. The organization audit-log request returned
HTTP 404 to the available authenticated principal, so it provides neither
positive nor negative cancellation evidence.

Because the initiating authority remains unavailable, changing repository code
would be speculative. If this occurs again, retain the run and job IDs, runner
identity, exact SHA, attempt number, full log, and UTC timestamps, then ask
GitHub Support—the owner of hosted-runner listener, control-plane, and host
lifecycle telemetry—to correlate those records. Organization owners can also
check the organization audit log for an explicit workflow cancellation if that
endpoint becomes available. This support/audit route is the remaining evidence
route, not a request to change providers or rerun an old execution.
