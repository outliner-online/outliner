#!/bin/bash
set -euo pipefail

SHARD_JOB_RESULT="${1:?usage: verify-server-test-job.sh SHARD_JOB_RESULT RESULTS TOTAL}"
RESULTS="${2:?usage: verify-server-test-job.sh SHARD_JOB_RESULT RESULTS TOTAL}"
TOTAL="${3:?usage: verify-server-test-job.sh SHARD_JOB_RESULT RESULTS TOTAL}"

if [ "$SHARD_JOB_RESULT" != "success" ]; then
    echo "Server test shard job did not succeed: $SHARD_JOB_RESULT" >&2
    exit 1
fi

exec node "$(dirname "$0")/verify-server-test-shards.mjs" "$RESULTS" "$TOTAL"
