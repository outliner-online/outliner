#!/bin/bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <repository> <run-id> <artifact-id> <destination>" >&2
  exit 64
fi

repository="$1"
run_id="$2"
artifact_id="$3"
destination="$4"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN is required for the artifact download" >&2
  exit 1
fi
if [[ ! "$artifact_id" =~ ^[1-9][0-9]*$ ]]; then
  echo "artifact id must be a positive integer" >&2
  exit 1
fi

archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT

for attempt in {1..30}; do
  artifact_ids="$(gh api \
    "repos/$repository/actions/runs/$run_id/artifacts?per_page=100" \
    --jq '.artifacts[].id')"
  if ! grep -Fxq "$artifact_id" <<<"$artifact_ids"; then
    echo "artifact $artifact_id is not in authenticated run $run_id inventory" >&2
    exit 1
  fi

  if gh api "repos/$repository/actions/artifacts/$artifact_id/zip" >"$archive"; then
    test -s "$archive"
    mkdir -p "$destination"
    unzip -q "$archive" -d "$destination"
    printf 'downloaded artifact %s from run %s after %s attempt(s)\n' \
      "$artifact_id" "$run_id" "$attempt"
    exit 0
  fi

  if (( attempt == 30 )); then
    echo "artifact $artifact_id did not become downloadable before the deadline" >&2
    exit 1
  fi
  sleep 2
done
