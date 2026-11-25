#!/usr/bin/env bash
# Re-run a workflow run whose jobs never reached a runner.
#
# Motivation: when GitHub cannot hand a queued job to a hosted runner it keeps
# retrying and, after roughly 15 minutes, kills the job with
#
#   The job was not acquired by Runner of type hosted even after multiple attempts
#
# Nothing of the job ran, yet the whole run is reported as a failure -- and in
# ci.yml a starved `pr-guards` takes all eleven downstream jobs with it, so a PR
# goes red without a single test having executed. The only useful response is to
# queue the run again.
#
# Signature of a starved job in the REST API:
#   conclusion  == "cancelled"
#   runner_name == ""            (no runner was ever assigned)
#   completed_at - started_at    >= the acquisition timeout
# while the run itself concludes as "failure". A run cancelled for an ordinary
# reason (a superseding push through `cancel-in-progress`, a manual cancel)
# concludes as "cancelled", and its jobs give up long before the timeout, so
# neither is retried here.
#
# A hosted runner can also die mid-run: the job then concludes as "failure"
# with a runner assigned, but its steps never reach a terminal state (e.g. run
# 38041845041, e2e core-3: startup frozen `in_progress`, the test step still
# `pending`, no step failed, job dead after ~1 minute with nothing executed).
# That shape carries no verdict either, so it is re-queued as well. The guard
# is deliberately narrow -- any job with a failed step keeps its failure --
# so a genuine test or script failure is never mistaken for a lost runner.
#
# Environment:
#   GH_TOKEN            token with `actions: write` on the repository
#   REPO                owner/name (defaults to GITHUB_REPOSITORY)
#   RUN_ID              the workflow run to inspect and re-run
#   RUN_ATTEMPT         attempt number that just concluded (default 1)
#   MAX_ATTEMPTS        stop retrying at this attempt count (default 3)
#   MIN_QUEUED_SECONDS  how long a job must have waited to count as starved
#                       (default 600, against an acquisition timeout of ~900)

set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
RUN_ID="${RUN_ID:-}"
RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
MIN_QUEUED_SECONDS="${MIN_QUEUED_SECONDS:-600}"

if [ -z "$REPO" ] || [ -z "$RUN_ID" ]; then
    echo "REPO and RUN_ID are required" >&2
    exit 1
fi

if [ "$RUN_ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    echo "Run $RUN_ID has already used $RUN_ATTEMPT of $MAX_ATTEMPTS attempts; not retrying."
    exit 0
fi

# Retry only this read, never a rerun write. Three 30-second reads (plus a
# five-second kill grace each) and six seconds of backoff fit the five-minute
# workflow budget. The HTTP status comes from gh's response headers, not an
# error message that could also describe an authentication or transport error.
jobs_endpoint="repos/$REPO/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT/jobs?per_page=100"
for read_attempt in 1 2 3; do
    api_exit=0
    api_response="$(timeout --kill-after=5s 30s gh api --include --method GET "$jobs_endpoint")" || api_exit=$?
    IFS= read -r status_line <<< "$api_response"
    http_status=""
    if [[ "$status_line" =~ ^HTTP/[0-9.]+[[:space:]]+([0-9]{3})([[:space:]]|$) ]]; then
        http_status="${BASH_REMATCH[1]}"
    fi

    if [ "$api_exit" -eq 0 ] && [ "$http_status" = "200" ]; then
        jobs_json="$(printf '%s' "$api_response" | sed '1,/^\r\{0,1\}$/d')"
        break
    fi

    if [ "$api_exit" -eq 1 ] && [[ "$http_status" =~ ^(502|503|504)$ ]] && [ "$read_attempt" -lt 3 ]; then
        delay_seconds=$((read_attempt * 2))
        echo "::warning::Jobs evidence unavailable for $REPO run $RUN_ID attempt $RUN_ATTEMPT (HTTP $http_status); retrying read $((read_attempt + 1))/3 in ${delay_seconds}s." >&2
        sleep "$delay_seconds"
        continue
    fi

    echo "::error::Jobs evidence unavailable for $REPO run $RUN_ID attempt $RUN_ATTEMPT (HTTP ${http_status:-unknown}, gh exit $api_exit); no rerun requested." >&2
    exit 1
done

# Missing fields are not negative evidence: in particular, a missing step
# status otherwise compares unequal to "completed" and looks like runner loss.
# Validate every job before emitting any classification. Slurping also rejects
# an empty body or multiple JSON documents. Keep the existing first-page scope.
if ! printf '%s' "$jobs_json" | jq -se --arg run "$RUN_ID" --arg attempt "$RUN_ATTEMPT" '
    def verdict:
      . == null or IN("success", "failure", "neutral", "cancelled", "skipped",
                      "timed_out", "action_required", "stale", "startup_failure");
    def status:
      IN("queued", "pending", "waiting", "requested", "in_progress", "completed");
    def timestamp:
      if . == null then true
      elif type == "string" then try (fromdateiso8601 | type == "number") catch false
      else false end;
    length == 1 and (.[0] |
      type == "object" and
      (.total_count | type == "number" and . >= 0 and floor == .) and
      (.jobs | type == "array") and
      ((.jobs | length) == ([.total_count, 100] | min)) and
      all(.jobs[];
        type == "object" and
        (.run_id | tostring) == $run and
        ((has("run_attempt") | not) or (.run_attempt | tostring) == $attempt) and
        (.name | type == "string" and length > 0) and
        (.status | status) and
        has("conclusion") and (.conclusion | verdict) and
        has("runner_name") and (.runner_name | . == null or type == "string") and
        has("started_at") and (.started_at | timestamp) and
        has("completed_at") and (.completed_at | timestamp) and
        (.steps | type == "array") and
        all(.steps[];
          type == "object" and (.status | status) and
          has("conclusion") and (.conclusion | verdict)
        )
      )
    )
' >/dev/null 2>&1; then
    echo "::error::Invalid jobs evidence for $REPO run $RUN_ID attempt $RUN_ATTEMPT (malformed, incomplete, or wrong target); no rerun requested." >&2
    exit 1
fi

starved="$(
    printf '%s' "$jobs_json" | jq -r --argjson min "$MIN_QUEUED_SECONDS" '
    [ .jobs[]
      | select(.conclusion == "cancelled")
      | select((.runner_name // "") == "")
      | select(.started_at != null and .completed_at != null)
      | select(((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601)) >= $min)
      | .name
    ]'
)"

starved_count="$(printf '%s' "$starved" | jq -r 'length')"

if [ "$starved_count" -gt 0 ]; then
    echo "$starved_count job(s) in run $RUN_ID never reached a runner:"
    printf '%s' "$starved" | jq -r '.[] | "  - " + .'
fi

runner_lost="$(
    printf '%s' "$jobs_json" | jq -r '
    [ .jobs[]
      | select(.conclusion == "failure")
      | select((.runner_name // "") != "")
      | select((.steps // []) | length > 0)
      | select([.steps[] | select(.conclusion == "failure")] | length == 0)
      | select([.steps[] | select(.status != "completed")] | length > 0)
      | .name
    ]'
)"

runner_lost_count="$(printf '%s' "$runner_lost" | jq -r 'length')"

if [ "$runner_lost_count" -gt 0 ]; then
    echo "$runner_lost_count job(s) in run $RUN_ID lost their runner before any step reported a verdict:"
    printf '%s' "$runner_lost" | jq -r '.[] | "  - " + .'
fi

if [ "$starved_count" -eq 0 ] && [ "$runner_lost_count" -eq 0 ]; then
    echo "No job in run $RUN_ID was starved of a runner; leaving the failure alone."
    exit 0
fi

# `rerun-failed-jobs` keeps the successful jobs of the attempt and re-queues the
# rest together with everything that depended on them. It rejects runs with no
# re-runnable failure, so fall back to re-running the whole thing.
if gh api -X POST "repos/$REPO/actions/runs/$RUN_ID/rerun-failed-jobs"; then
    echo "Re-queued the failed jobs of run $RUN_ID (attempt $((RUN_ATTEMPT + 1)))."
else
    echo "Re-running the failed jobs was rejected; re-running the whole run instead."
    gh api -X POST "repos/$REPO/actions/runs/$RUN_ID/rerun"
    echo "Re-queued run $RUN_ID (attempt $((RUN_ATTEMPT + 1)))."
fi
