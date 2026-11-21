${identity}

## Objective

Reduce the execution time of the ${family_name} CI job family while preserving its existing verification.

## Context

The daily monitor verified at least two distinct successful default-branch runs of the same current job variant with at least ${threshold} seconds of native test work and test-command elapsed time in `${workflow_path}`. ${recommendation}. Each qualifying native report covers multiple test files. Review dependencies between those files before selecting a safe optimization.

${evidence}

## Requirements

REQ-001: Use the linked job/step evidence and the current workflow/test entry points to identify and reduce the observed execution bottleneck in the ${family_name} family; distinguish queue time, setup time, test-command elapsed time, and retry time before selecting the change.
REQ-002: When independent test work dominates, split or rebalance the complete existing test selection so that each selected test is assigned to exactly one shard per intended profile, retaining the original runner retry/failure semantics; when setup/runtime dominates or the work is indivisible, optimize that demonstrated bottleneck instead of introducing ineffective shards.
REQ-003: Preserve the existing test selection, required check names, native test failures, coverage/artifact aggregation, and required browser/runtime prerequisites; do not obtain a faster result by omitting checks, suppressing failures, shortening timeouts, or adding automatic retries.
REQ-004: Verify changed orchestration through the supported test/CI entry point, including complete selection and failure propagation, and report comparable before/after job and step timings with concurrency, setup, and environment differences identified; do not present estimated shard work as measured end-to-end latency.

## Acceptance Scenarios

- Given the reported slow family, when its current workflow and diagnostic evidence are inspected, then the selected change addresses the measured execution bottleneck and distinguishes queue/setup/retry contributions (REQ-001, REQ-002).
- Given the same selected tests and profiles, when the changed orchestration runs, then all intended tests remain covered and a native failure still fails the existing required check (REQ-002, REQ-003, REQ-004).
- Given representative before/after runs, when the improvement is reported, then actual job/step durations and material environment differences are shown without claiming a universal ten-minute guarantee (REQ-004).

## Non-goals

Changing unrelated workflows, weakening verification, guaranteeing runner availability, changing publication authority, or increasing timeouts to hide the bottleneck.

## Initial Implementation Prompt

This section is guidance; the explicit REQ-NNN entries are the sole implementation contract. Inspect the current checkout before editing: the source references below describe the monitor's reviewed baseline `${source_ref}`, while the evidence identifies the actual observed source SHA.

### Verified source entry points

${source_links}

### Repository-specific plan

${guidance}

### Implementation and regression sequence

1. Read the workflow and the named runner/planner sources. Compare the reported longest steps with the full job logs and existing timing artifacts. Establish the complete selected inventory/profile set and the stable aggregate check before changing orchestration.
2. Use the existing sharding/planning mechanism where one exists. Establish which independent work can move between jobs; shared services, global fixtures, and indivisible tests are constraints to inspect, not assumptions supplied by step elapsed times.
3. Make the smallest change addressing that bottleneck. Keep the same complete verification and the original failure semantics. If splitting requires an independent missing capability, send that prerequisite through specification decomposition before implementation.
4. Extend the repository's existing orchestration regression tests with exact selection/coverage and a deliberately failing test or job. Run its supported focused verification command and the resulting GitHub checks.
5. Record comparable before/after durations, runner count, setup duplication, and queue time. Do not claim success from a changed matrix alone or from helper-only timing estimates.

### Handoff limits

The monitor supplies metadata evidence and known source pointers, not a live code-level proof of a safe split. Reviewers must confirm the current implementation plan and any necessary decomposition before implementation; preserve the fixed Objective while repairing material specification gaps.
