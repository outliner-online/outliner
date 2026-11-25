# Observing displayed object changes

The server observes enabled notification rules for Grid, Calendar, and Kanban
objects without an open browser. Each rule selects a project, object, explicit
display context, and independently enabled MCP/mobile channels. The authoritative
headless view service produces the same complete semantic projection as the
corresponding UI. Notifications compare those projections, so edits to hidden
fields, filtered-out rows, or unchanged aggregate inputs do not create a change.
Meaningful displayed order, membership, groups, values, and labels do.

This runtime prepares delivery opportunities. The MCP Events and smartphone
channel adapters are separate integrations; preparing a change does not establish
that a provider accepted it or that a person or agent received or processed it.

## Baselines, coalescing, and restart

The first complete current projection establishes a silent baseline on startup,
enabling a channel, replacing a display context, or recovering from a lost source
incarnation. Absent, failed, incomplete, inaccessible, or stale evidence is never
an empty successful result. A temporary evaluation failure retains the previous
baseline in the same source incarnation; recovery to identical content stays
silent.

Source invalidations are coalesced per admitted rule. Evaluation is scheduled
after five quiet seconds, with a maximum wait of thirty seconds from the first
outstanding invalidation. Edits during an evaluation keep that rule dirty.
Evaluation capacity defers the scheduled attempt explicitly and keeps its
baseline and coalesced dirty state. The maximum wait bounds scheduling, not an
unavailable evaluation slot or an external service's completion time.
Waiting for a previous candidate's aggregate outcome does not suspend this
scheduling; another candidate for that channel is offered only after settlement.

Baselines, prepared candidates, dirty state, timers, and attempt payloads exist
only in process memory. Restart loses pending work and silently observes the
current result. There is no pending-event database, outbox, notification history,
retry queue, or replay cursor. Durable notification settings and device or
subscription configuration remain separate from this transient state.

## Adapter contract

An adapter subscribes to its runtime channel and receives a `PreparedViewChange`.
The immutable payload includes an event ID for that single opportunity, rule ID,
channel, full target identity, observation time, settings revision, source version
token, explicit effective context, canonical object link, and bounded summary.
The prior and proposed next projections remain internal runtime state.

Before initiating a send, call `revalidate()` from the HTTPS transport's
`beforeSend` preparation boundary. This freshly checks project access and source
currency, together with the current rule/channel generation. A `current` result
authorizes the same captured payload and event ID. In the transport's final guard,
require `checkCurrent().status === "current"` and the destination's own lease
guard to pass. This synchronous producer-owned result distinguishes terminal lease
expiry from revoked authority or stale content. The Boolean `isCurrent()` helper
remains available when the caller does not need the refusal reason. Check after
all asynchronous work, immediately before the first HTTP body `write`/`end`,
without an intervening await. A local guard does not claim
atomic serialization with an external ACL change.
By default, thirty seconds after preparation the candidate's currentness guard
refuses new send initiation. Expiry does not fabricate an initiation outcome or
settle the baseline; the adapter must still report its actual aggregate outcome.
When revalidation or the final synchronous guard returns `cancelled` with reason
`expired`, report a terminal `expired` outcome, rather than the revocation outcome
`cancelled`. If the captured
semantic change is still current and no destination wrote bytes, settlement skips
that opportunity once; the send deadline alone must not cause the same change to
be offered repeatedly.

If A changed to B and returned to A before sending, the candidate is cancelled.
If it became C, the old B capability is invalidated; C is offered separately with
its own payload and event ID. Do not reuse B's signed or encrypted bytes for C.
Disabling a channel, removing a rule or object, changing its context, observing
access loss, or replacing its source incarnation also revokes old capabilities.

Report one aggregate `settleAttempt` outcome after the bounded opportunity. If
any destination initiated the exact captured candidate, the baseline advances
once to that candidate's captured next projection, regardless of provider
acceptance, failure, expiry, or an unknown outcome. Do not retry the candidate.
If no destination initiated, revoked, reverted, superseded, or deferred work does
not advance the baseline. A still-current terminal no-destination or pre-write
failure advances once as a skipped best-effort opportunity. Completion in a
retired generation cannot restore its baseline.

## Summary and status

Summary counts describe previous/current displayed item counts, changed visible
positions, and changed labels. They do not infer source-row insert/update counts
from hidden record identities. Calendar item counts cover projected layout
entries, which can include visible decorations and labels. Examples use known
displayed fields only: Grid cells and column labels, Kanban cards/details/lanes,
and Calendar titles or labels. There are at most three examples; each string is
at most 120 Unicode code points including a trailing ellipsis when shortened.
Per-example flags and `examplesTruncated` make omissions explicit. Full source
rows and hidden fields are never included.

Read-only status is scoped to the authenticated owner's configured rules and
channels through the `get_notification_status` MCP tool. `warming` means no complete baseline is established yet; `watching`
means a baseline exists; `blocked` reports a bounded unavailable/error/capacity
category; `disabled` identifies an inactive rule/channel. Status does not expose
another owner's targets or content, and never claims delivered, read, or
processed. The observation time describes a past observation; following the
object link opens its current contents, which may have changed again.

## Finite resource budgets

Default process-wide limits apply across all owners:

| Resource                                          | Default limit |
| ------------------------------------------------- | ------------- |
| Retained rule admissions                          | 32            |
| Admissions per owner                              | 8             |
| Concurrent opening/evaluation operations          | 2             |
| Runtime retained-state accounting budget          | 16 MiB        |
| One complete projection, including DTO accounting | 512 KiB       |
| Pending delivery attempts                         | 64            |
| Durable discovery page                            | 16 rules      |
| Source Table rooms per retained observation       | 32            |
| Reconciliation interval                           | 1 second      |
| Admission lease before resource reclamation       | 5 minutes     |
| New-send authorization lifetime for a candidate   | 30 seconds    |

The scheduler uses one timer and a bounded keyset-discovery page, rather than an
unbounded per-owner waiting list. Admission accounting includes bookkeeping for
retained handles, channel baselines, candidates/attempt state, and coalesced dirty
entries. It reserves the producer's projection budget before opening the
observation, so the total memory budget can admit fewer than the maximum 32 rules.
Projected DTOs are charged for object/array/string headers and contents; runtime
serialization strings are also charged. This is a conservative accounting model,
not a measurement of V8 process RSS.

The production observer rejects oversized projections before retaining them.
After deriving a Kanban notification projection, it drops diagnostic source rows,
metadata, and write routes; ordinary MCP diagnostics keep their existing output.
Canonical Y.Docs belong to the existing room host. The notification runtime bounds
the additional leases/listeners retaining those documents. Source refresh can
temporarily retain an old and new capture, bounded by twice the configured
Table-room limit plus their project handles; retired document listeners are
pruned. Temporary evaluation workspace is separately bounded by two concurrent
operations and the headless evaluator's 8 MiB result-size limit. The discovery
page is bounded independently; each owner's durable settings are already capped
at 128 rules and 64 KiB.

Resource pressure is visible as deferral or unavailability, never a successful
empty result. Capacity release and bounded reconciliation provide deferred rules
a path to observation. Explicit reclamation invalidates old candidates and
releases their resources. Readmission starts a new generation and silently
baselines current content, with no comparison against abandoned state.

An adapter must supply truthful aggregate initiation evidence even when its
provider fails. Returning or throwing does not prove that no request wrote bytes.
Unsettled opportunities and callbacks that have not completed continue consuming
their bounded attempt/memory capacity. Closing the runtime revokes every send
capability and releases observation work; shutdown does not await external
provider callbacks, and later callbacks cannot restore retired baselines.
