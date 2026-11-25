#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <repository> <artifact-id>" >&2
  exit 64
fi

repository="$1"
artifact_id="$2"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN is required for the unavailable artifact request" >&2
  exit 1
fi

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
