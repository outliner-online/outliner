# Buffered WebSocket fresh-observer incident

## Evidence

Ordinary CI run `44925168078`, attempt 1, on-prem job `136910182768` failed the buffered-cancellation
scenario after the target tunnel's independently observed cleanup and after the surviving peer rendered its
new marker. The native artifact `14715700751` contains the Playwright trace, failure snapshot, and backend
log. The backend log records document-change and SQLite-store callbacks through `16:39:47.240Z`, after the
peer edit. The trace's final observer snapshot shows `Not signed in`, a password form, and `Login required`;
it does not show a fresh observer document connection or synchronization attempt.

The evidence therefore proves the target cleanup completed and the original peer produced locally rendered
state that reached the backend's document/store path. It also proves that the failing assertion observed an
unauthenticated page, not an authenticated observer that had loaded the document and rejected or missed the
marker. The trace does not prove whether the marker was present in the particular persisted update, and it
does not establish a publication, persistence, or document-synchronization defect.

## Correction boundary

The shared on-prem login helper previously returned as soon as Playwright clicked the login button. That
click only starts the application's asynchronous login handler, so the scenario could immediately navigate
the fresh context before the session response had been consumed. The helper now waits for the UI's real
authenticated or rejected outcome before returning.

The focused buffered-cancellation scenario continues to require independent target cleanup and the original
peer tunnel. It additionally identifies a distinct fresh-observer tunnel, waits for backend data on that
exact tunnel, and only then accepts the observer's rendering of the unique marker. Missing authentication,
missing observer data, missing marker visibility, or replacement/loss of the original peer tunnel remains a
failure; no timeout, retry, skip, or fixed sleep is used as the oracle.

## Validation record

At correction head `2c95533d47a792d6de6db4d1d5d6cbc12061607d`, ordinary CI run `44967247160`,
attempt 1, on-prem job `137039367375` ran the production-built on-prem shard with retries disabled. The
job passed all 26 tests, including the buffered-cancellation scenario, in 3 minutes 22 seconds.

The separate focused command
`npx playwright test --config playwright.onprem.config.ts e2e/onprem/onp-websocket-buffered-cancellation-5586c10d.spec.ts --retries=0 --trace=off`
was also run from that head. Playwright collected and started exactly one test, but this constrained worker
took longer than the committed 120-second test deadline and timed out; the run is not recorded as success.
Earlier attempts on the same worker were blocked first by an absent Chromium binary, then absent Chromium
system libraries, and then a stale physical `shared/node_modules` directory that loaded Yjs twice. Installing
the pinned browser and its system dependencies and restoring the intended `shared/node_modules` symlink
removed those startup blockers, but did not make the focused scenario complete within its unchanged bound.
The ordinary shard result therefore supplies successful native-path evidence, while successful separate
focused validation remains unavailable in this environment. No timeout, retry, or test assertion was changed
to convert the incomplete focused run into a pass.
