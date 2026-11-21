#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
node scripts/ci/verify-unit-shards.mjs "${UNIT_ARTIFACT_DIR:-unit-artifacts}" "${UNIT_SHARD_COUNT:-2}"
mkdir -p job_logs
cd client
if [[ -n "${UNIT_BASE_RUNNER:-}" ]]; then
  "$UNIT_BASE_RUNNER" 2>&1 | tee ../job_logs/base-test.log
else
  npm run test:base 2>&1 | tee ../job_logs/base-test.log
fi
