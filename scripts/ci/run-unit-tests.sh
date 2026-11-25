#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/client"
shard="${UNIT_SHARD:-}"
vitest_bin="${UNIT_VITEST_BIN:-./node_modules/.bin/vitest}"
config_args=()
[[ -z "${UNIT_VITEST_CONFIG:-}" ]] || config_args+=("--config=$UNIT_VITEST_CONFIG")
if [[ -z "$shard" ]]; then
  "$vitest_bin" run "${config_args[@]}" --project unit --coverage
  npm run test:base
  exit
fi
[[ "$shard" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || { echo "UNIT_SHARD must be N/T" >&2; exit 64; }
shard_index="${BASH_REMATCH[1]}"
shard_total="${BASH_REMATCH[2]}"
(( shard_index <= shard_total )) || { echo "Invalid UNIT_SHARD: $shard" >&2; exit 64; }
coverage_dir="${UNIT_COVERAGE_DIR:-../coverage/unit-shard-${shard_index}}"
evidence_dir="${UNIT_EVIDENCE_DIR:-../unit-evidence}"
evidence_file="$evidence_dir/shard-${shard_index}.json"
mkdir -p "$(dirname "$evidence_file")"
"$vitest_bin" run "${config_args[@]}" --project unit --coverage --shard="$shard" \
  --reporter=github-actions --reporter=dot --reporter=json \
  --outputFile.json="$evidence_file" --coverage.reportsDirectory="$coverage_dir"
test -s "$evidence_file"
test -s "$coverage_dir/coverage-final.json"
