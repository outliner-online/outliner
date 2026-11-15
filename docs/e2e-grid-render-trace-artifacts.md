# Grid render trace artifacts in E2E failures

When a Playwright test that touches a Grid fails, its report gains one or
more `grid-render-trace-*.json` attachments alongside the existing
screenshot/video/log artifacts. They reuse the structured `GridRenderTrace`
introduced in #5128 (`client/src/services/yjstable/gridRenderTrace.ts`) so
there is exactly one trace format shared by the WebMCP `getCurrentGridTrace`
tool and E2E diagnostics.

## Where the data comes from

- `client/src/services/yjstable/gridRenderTraceRegistry.ts` is an always-on,
  browser-global registry: every mounted `YjsTableView` registers a getter
  for its own `GridRenderTrace` (built the same way as the WebMCP tool) under
  its Grid ID, and unregisters on unmount. It requires no host integration
  (unlike WebMCP, which only activates when `window.WebMCP` is injected by an
  extension), so it works in a plain Playwright-driven Chromium.
- `client/e2e/fixtures/grid-render-trace.ts` exports `test`/`expect` that
  wrap Playwright's `page` fixture. On teardown, when a test's outcome
  differs from its expected status (a genuine failure or timeout — the same
  condition Playwright's own "on-failure" screenshot/trace/video modes use,
  so a `test.fail()`-flagged expected failure is correctly treated as noise,
  not something to diagnose), it calls `window.__outlinerGridRenderTraces.collect()`
  through `page.evaluate()` and attaches the result via `testInfo.attach()`.
  Capture is best-effort: a page that already crashed or closed after the
  failure logs a warning instead of throwing, so it never masks the original
  failure or fails the test a second time.

Grid E2E specs opt in by importing `test`/`expect` from
`client/e2e/fixtures/grid-render-trace.ts` instead of `@playwright/test`
directly (see `client/e2e/tables/*.spec.ts`).

Multi-page tests can wrap the owned destination operation with
`withGridFailureCapture(destination, testInfo, "destination", operation)`
inside their existing `try`/`finally`. On failure, it captures that page before
the caller closes it, then rethrows the identical original error. Labeled
attachments record the URL, focus, connection, durable Grid/Table IDs, DOM
Grid IDs, accessibility snapshot and render traces without overwriting the
source page's teardown evidence. Browser reads share a six-second diagnostic
budget; unavailable stages are retained in `destination-capture-errors.json`.
Missing registries are marked unavailable rather than represented as empty ID lists.
Passing operations add no diagnostic reads or attachments.

For the primary `new-2` and `tables-1` CI commands, `scripts/ci/run-bounded-e2e.py` reserves
time for evidence upload within the unchanged 30-minute job limit. It caps
the command at 20 minutes, or 22 minutes from execution-context initialization,
whichever comes first, then terminates and reaps its descendants (including
detached browser processes). `job_logs/new-2-command-status.json` and
`job_logs/tables-1-command-status.json` distinguish
normal completion, timeout (exit 124), interruption, leftover children and
supervisor/report validation failure. Existing nonzero command exits remain
nonzero; a zero exit requires a fresh Playwright JSON report with executed,
passing cases. Existing retry outcomes are retained in that report rather
than described as first-attempt success.

The log is written directly to `job_logs`, so an orphan holding a console
pipe cannot block the supervisor's exit. Console copies use nonblocking writes;
backpressure drops only console copies, counted in `console_dropped_bytes`,
while the complete file remains available for upload. Subsequent checks retain their
separate output paths. Missing archive inputs fail the upload step. This
does not guarantee evidence survives an external runner loss or outer job
cancellation, and does not establish any Grid failure's cause. The Linux
subreaper mechanism is documented in the
[Linux manual](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).

The `tables-1` boundary retains the original `--project=tables --shard=1/2`
selection. It was added after that shard reached the outer job limit before
diagnostic upload, leaving its actual failing/stalled spec unknown. Other
shards are not brought under this boundary automatically.

## Artifact format and location

Each file is written directly under `client/test-results/<test-id>/` (via
`testInfo.outputPath()`) and then registered as a `path`-based
`testInfo.attach()`, so it is a real, independently-openable file — not only
recoverable by decoding a reporter's JSON output. `client/test-results/` is
uploaded as a CI artifact whenever a job fails, and for `new-2` and `tables-1` even when
retries make the job succeed (see
`.github/workflows/ci-test-e2e.yml`), with no dependency on which reporters
are enabled. The two subsequent retry-free Grid checks use separate output
and HTML report directories under `job_logs/`; Playwright clears these
directories at each invocation, so sharing the primary suite paths would
erase its failed-attempt attachments and report before upload. This
preserves existing captures; it does not enable Playwright trace ZIP
recording for Chromium or establish a flaky test's cause. Two kinds of file
are written per failing test that had a Grid
mounted:

- `grid-render-trace-index.json` — one per test, correlating the trace(s)
  with the failure:
  ```json
  {
      "test": "Suite name > test title",
      "file": "/abs/path/to/the.spec.ts",
      "project": "tables",
      "retry": 0,
      "url": "http://localhost:7090/grids/demo/some-grid",
      "gridIds": ["some-grid"]
  }
  ```
- `grid-render-trace-<gridId>.json` — one per mounted Grid, the
  `GridRenderTrace` itself: a `config` stage (query, revision, column
  order/visibility), an optional `query-execution` stage (backend
  provenance), a `client-state` stage (what the sync adapter has), and a
  `render` stage (what was actually drawn, with a bounded row/column
  sample). Comparing stages pairwise shows where a divergence started; see
  `client/src/services/yjstable/gridRenderTrace.ts` for the exact shape and
  its size bounds (row/column/value truncation), which keep the artifact
  small even for a large query result.

If no Grid was mounted when the test failed, no `grid-render-trace-*` files
are attached — existing screenshots, videos, and logs are unaffected either
way. Automatic page teardown only captures failed tests; explicit regression
tests may attach controlled-failure snapshots while their own assertions pass.

## Validating the mechanism

`client/e2e/env/env-grid-render-trace-artifact-9f433761.spec.ts` exercises
the same collection/attachment functions the fixture calls automatically,
against a real mounted demo Grid, so a broken stage or a renamed field is
caught by CI without needing a red run.

To see the mechanism trigger on an actual failure (e.g. after touching the
render pipeline), force one locally:

1. Temporarily break an assertion in a spec that imports `test`/`expect`
   from `client/e2e/fixtures/grid-render-trace.ts` (for example, expect a
   nonexistent column header in `client/e2e/tables/tbl-standalone-grid-page-2e6b9f14.spec.ts`).
2. Run it with `scripts/test.sh client/e2e/tables/tbl-standalone-grid-page-2e6b9f14.spec.ts`.
3. Look under `client/test-results/<the failing test's directory>/` and
   confirm it contains `grid-render-trace-index.json` and a
   `grid-render-trace-<gridId>.json` next to the existing `error-context.md`
   (and any screenshot/video), and that the index's `gridIds`/`url` correlate
   with the failing test.

Grid traces identify the Grid and optional explicit INSERT preference through `sourceDiagnostics`, with actual relation identities, supplier proof and INSERT resolution. They have no singular source Table/document field. Retained rows are stale whenever current execution evidence is missing, loading, failed, or invalidated; an unchanged SQL string alone does not establish currentness. Browser traces observe rendering, while server render stages remain explicitly inferred. Unmeasured timing is omitted.

Source diagnostics distinguish producer-certified dependency completeness from
supported write lineage. Every public nested relation uses `{ kind, id, sqlName }`;
internal `schemaRevision` values are omitted. Prose and unverified display claims
are bounded to 512 characters with `[truncated]`; relation/branch/column counts and
100-entry truncation flags remain available. The mounted browser regressions
`mcp-view-sources-unknown-5706cafe.spec.ts` and
`mcp-view-sources-bounds-5706b0ad.spec.ts` cover unresolved successful reads and a
schema applied through the normal editor with a 64 KiB comment.
