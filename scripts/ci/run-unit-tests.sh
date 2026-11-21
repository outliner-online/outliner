#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/client"
shard="${UNIT_SHARD:-}"
run_base="${UNIT_RUN_BASE:-true}"
coverage_dir="../coverage/unit_and_integration"
evidence_file=""
shard_args=()
reporter_args=()
if [[ -n "$shard" ]]; then
  [[ "$shard" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || { echo "Invalid UNIT_SHARD: $shard" >&2; exit 64; }
  shard_index="${BASH_REMATCH[1]}"
  shard_total="${BASH_REMATCH[2]}"
  (( shard_index <= shard_total )) || { echo "Invalid UNIT_SHARD: $shard" >&2; exit 64; }
  coverage_dir="../coverage/unit-shard-${shard_index}"
  evidence_file="../unit-evidence/shard-${shard_index}.txt"
  mkdir -p "$(dirname "$evidence_file")"
  shard_args+=("--shard=$shard")
  reporter_args+=("--reporter=json" "--outputFile.json=$evidence_file.json")
fi
npx vitest run --project unit --coverage --reporter=github-actions --reporter=dot \
  "${shard_args[@]}" --coverage.reportsDirectory="$coverage_dir" \
  "${reporter_args[@]}"
test -s "$coverage_dir/coverage-final.json"
if [[ -n "$evidence_file" ]]; then
  node -e 'const fs=require("fs"); const input=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const files=[...new Set(input.testResults.map(result=>result.name))].sort(); if(!files.length) process.exit(1); fs.writeFileSync(process.argv[2],files.join("\n")+"\n")' "$evidence_file.json" "$evidence_file"
fi
if [[ "$run_base" == true ]]; then
  npm run test:base
elif [[ "$run_base" != false ]]; then
  echo "UNIT_RUN_BASE must be true or false" >&2
  exit 64
fi
