#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/client"
shard="${UNIT_SHARD:-}"
run_base="${UNIT_RUN_BASE:-true}"
coverage_dir="../coverage/unit_and_integration"
evidence_file=""
shard_args=()
if [[ -n "$shard" ]]; then
  [[ "$shard" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || { echo "Invalid UNIT_SHARD: $shard" >&2; exit 64; }
  shard_index="${BASH_REMATCH[1]}"
  shard_total="${BASH_REMATCH[2]}"
  (( shard_index <= shard_total )) || { echo "Invalid UNIT_SHARD: $shard" >&2; exit 64; }
  coverage_dir="../coverage/unit-shard-${shard_index}"
  evidence_file="../unit-evidence/shard-${shard_index}.txt"
  mkdir -p "$(dirname "$evidence_file")"
  npx vitest list --project unit --filesOnly --shard="$shard" | sed -n '/\.\(test\|spec\)\.\(js\|ts\|svelte\)$/p' | sort -u > "$evidence_file"
  test -s "$evidence_file"
  shard_args+=("--shard=$shard")
fi
npx vitest run --project unit --coverage --reporter=github-actions --reporter=dot \
  "${shard_args[@]}" --coverage.reportsDirectory="$coverage_dir"
test -s "$coverage_dir/coverage-final.json"
if [[ "$run_base" == true ]]; then
  npm run test:base
elif [[ "$run_base" != false ]]; then
  echo "UNIT_RUN_BASE must be true or false" >&2
  exit 64
fi
