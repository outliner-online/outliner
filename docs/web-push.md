# Smartphone notifications

Cloud deployments can deliver changes to the displayed result of a saved Grid,
Calendar, or Kanban to an enrolled smartphone browser. Each notification describes
an observation in the past, includes its time, and opens the current object in the
same saved display context. An edit made after transmission can change or revert
that result before the notification is opened.

## Setup and one observation

Configure one stable VAPID identity with `WEB_PUSH_VAPID_PUBLIC_KEY`,
`WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT` (an HTTPS URL or `mailto:`
contact). Missing or invalid configuration is shown as unavailable; Outliner never
generates or rotates keys at startup.

1. On the intended smartphone, sign in to the cloud deployment and open
   **Settings → Smartphone notifications**. Enroll this browser from its button
   and accept the browser permission prompt. The site must use a secure context
   with the existing root Service Worker and Push API. On supported iOS/iPadOS
   browsers, install the site on the Home Screen before enrollment.
2. Through MCP, use `get_notification_settings` and `list_notification_targets`
   to identify an authorized Grid, Calendar, or Kanban. Save a rule with
   `update_notification_settings`, an explicit versioned display context,
   `enabled: true`, and `channels.mobile: true`. Preserve the independently chosen
   `channels.mcp` flag and use the latest `expectedRevision`.
3. Wait for `get_notification_status` to report that the rule is watching, then
   change one displayed field. A hidden-field edit, a filtered-out record, an
   unchanged aggregate, or an extra outline placement is not a displayed change.
4. A valid notification displays a short past-tense description and observation
   time. Tap it to open that object with its saved context. Normal sign-in,
   project access, and object availability checks still apply.

Changing the target or either channel through MCP does not request browser
permission again. Smartphone enrollment is account-private and is not enabled by
visiting the anonymous demo.

## Delivery and privacy

Each account can retain 16 active browser registrations and 32 total active or
inactive records. One eligible visible change gets one bounded best-effort
opportunity per captured device revision. Independent valid devices can proceed
when another fails. There is no automatic retry, application outbox, history, or
replay after a server restart. Startup establishes a silent fresh baseline.

The encrypted version-1 JSON payload is at most 3000 UTF-8 bytes. It contains the
event and rule identities, stable target, observation time, a bounded displayed
summary, exact context link, and an opaque local enrollment generation. It excludes
account uid, endpoint, encryption keys, raw SQL, hidden fields, and full snapshots.
Shortened examples retain an explicit ellipsis. If required identity or context
cannot fit, the opportunity fails without substituting another page or context.

The server generates Web Push encryption and VAPID bytes with `web-push` and sends
only through the existing public-address-pinned HTTPS transport. It revalidates
the exact candidate after TLS preparation and checks the current candidate,
owned device revision, configured key, and server lifetime immediately before the
first request write. It requests TTL **60 seconds**, **normal** urgency, and an
opaque per-rule/device replacement Topic. A provider can discard or replace a
pending notification. A 404/410 conditionally disables only the attempted device
revision; 429, server errors, and ambiguous results are discarded without retry.

**Accepted** means the provider accepted the request. It does not mean the phone
displayed it or the person read it. Logs and result categories do not contain
push destinations, credentials, whole payloads, or displayed content.

## Disablement, logout, and taps

Disabling first commits a durable local disarm, then attempts server disablement
and browser unsubscription. The browser-wide IndexedDB transaction boundary also
orders notification display and every focus, navigation, or window-open initiation.
After verified disarm, an old generation cannot begin a new display or navigation,
even when external cleanup fails or another account signs in. Stale notifications
are closed without navigation. A healthy current-generation push is shown even
when a foreground window is already open.

An operation already initiated before disarm cannot be recalled. If the local
write fails while the prior active binding remains readable, Outliner reports
incomplete cleanup and blocks app-managed account transition or re-enrollment;
it does not claim that old previews have been suppressed. A stopped/restarted
worker uses the durable binding rather than the presence of a client window.

Only a validated root-relative link to the payload's exact project/object with
its explicit saved context is used. External, protocol-relative, malformed,
context-free, and unrelated fallback links are refused. Navigation shows the
current object, normal login, or its ordinary unavailable/access-denied state.
No historical snapshot is restored.

## Bounded real-smartphone smoke procedure

Use one explicitly authorized smartphone, one private test object, and one
mobile-enabled rule. Record the deployment commit, date, OS/browser versions,
Home Screen/standalone mode, and enrollment result without recording its endpoint
or keys. Then:

1. Close the watched object view. Change a hidden field and verify no new request
   or visible notification for that edit.
2. Change one displayed value. Record provider acceptance separately from the
   actual notification text/time seen on the phone.
3. Tap it and record the opened project/object and saved display context. Revert
   the value afterwards and confirm the live object reflects the later state.
4. Disable the device. Change one more displayed value and verify no new request
   begins for the disabled revision.

### Actual handset result for issue #5987

On **2026-11-26**, no explicitly enrolled physical smartphone was available to the
implementation environment. OS/browser/Home Screen mode, handset receipt, tap,
and real-device disablement were therefore **not verified**. No live provider
notification was sent as a substitute. Automated encrypted-request and
production-built-worker tests exercise controlled boundaries; they must not be
reported as proof of handset delivery.
