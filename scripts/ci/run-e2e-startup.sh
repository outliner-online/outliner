#!/usr/bin/env bash
# One complete startup budget covers both attempts and completion validation.
set -euo pipefail
: "${E2E_PROJECT:?}" "${E2E_EXECUTION_ID:?}"
[[ "$E2E_PROJECT" =~ ^[a-zA-Z0-9_-]{1,160}$ && "$E2E_EXECUTION_ID" =~ ^[a-zA-Z0-9_-]{1,160}$ ]]
mkdir -p job_logs
export STARTUP_PREFIX="job_logs/${E2E_PROJECT}-startup"
export STARTUP_NONCE
STARTUP_NONCE=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
# Progress and raw stdout stay outside all upload paths, including on timeout.
private_dir=$(mktemp -d)
trap 'rm -rf "$private_dir"' EXIT
export STARTUP_PROGRESS="$private_dir/progress.json"
rm -f "${STARTUP_PREFIX}-completed.json" "${STARTUP_PREFIX}-status.json" "${STARTUP_PREFIX}-evidence.json" "job_logs/setup-services-${E2E_PROJECT}.log"
startup_phase() {
  printf '{"phase":"%s","attempt":%s}\n' "$1" "$attempt" > "$STARTUP_PROGRESS"
}
run_startup_attempts() {
  local -x attempt=1
  local status
  local max_attempts=2
  while true; do
    startup_phase pre_readiness
    if bash scripts/ci-e2e-start.sh; then
      break
    else
      status=$?
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then return "$status"; fi
    attempt=$((attempt + 1))
  done
  startup_phase completion
  python3 - <<'PY'
import json, os
from pathlib import Path
Path(os.environ['STARTUP_PREFIX'] + '-completed.json').write_text(json.dumps({
    'status': 'completed', 'shard': os.environ['E2E_PROJECT'],
    'execution_id': os.environ['E2E_EXECUTION_ID'], 'nonce': os.environ['STARTUP_NONCE'],
}) + '\n')
PY
}
export -f startup_phase run_startup_attempts
python3 scripts/ci/run-bounded-e2e.py \
  --context=job_logs/execution-context.json \
  --status="${STARTUP_PREFIX}-status.json" \
  --log="job_logs/setup-services-${E2E_PROJECT}.log" \
  --startup-completion="${STARTUP_PREFIX}-completed.json" \
  --startup-shard="$E2E_PROJECT" --startup-execution-id="$E2E_EXECUTION_ID" \
  --startup-nonce="$STARTUP_NONCE" --startup-progress="$STARTUP_PROGRESS" \
  --timeout-seconds=360 --job-budget-seconds=1320 --grace-seconds=10 \
  -- bash -euo pipefail -c run_startup_attempts
