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
