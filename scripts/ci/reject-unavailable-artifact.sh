#!/bin/bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <repository> <run-id> <unavailable-id> <expected-id> <wrong-id>" >&2
  exit 64
fi

repository="$1"
run_id="$2"
artifact_id="$3"
expected_artifact_id="$4"
wrong_artifact_id="$5"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN is required for the unavailable artifact request" >&2
  exit 1
fi

verify_authenticated_inventory() {
  local artifact_ids
  artifact_ids="$(gh api \
    "repos/$repository/actions/runs/$run_id/artifacts?per_page=100" \
    --jq '.artifacts[].id')"
  grep -Fxq "$expected_artifact_id" <<<"$artifact_ids"
  grep -Fxq "$wrong_artifact_id" <<<"$artifact_ids"
  ! grep -Fxq "$artifact_id" <<<"$artifact_ids"
}

verify_authenticated_inventory

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
if gh api --include \
  "repos/$repository/actions/artifacts/$artifact_id/zip" \
  >"$response_file" 2>/dev/null; then
  request_exit=0
else
  request_exit=$?
fi

http_status="$(awk '/^HTTP\/[0-9.]+ [0-9][0-9][0-9]/{status=$2} END{print status}' "$response_file")"
"$(dirname "$0")/verify-unavailable-artifact-response.sh" \
  "$request_exit" "$http_status" "$artifact_id"
verify_authenticated_inventory
