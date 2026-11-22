#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHARD="${SERVER_TEST_SHARD:?SERVER_TEST_SHARD must be INDEX/TOTAL}"
if [[ ! "$SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
    echo "Invalid SERVER_TEST_SHARD: $SHARD" >&2
    exit 2
fi
INDEX="${BASH_REMATCH[1]}" TOTAL="${BASH_REMATCH[2]}"
RESULT_DIR="${SERVER_TEST_RESULT_DIR:-$ROOT_DIR/server-test-results/shard-$INDEX}"
mkdir -p "$RESULT_DIR"

cd "$ROOT_DIR/server"
# Mocha performs discovery for the canonical wrapper glob and exclusions. The
# dry run supplies the native, unsplit identity oracle from this same checkout.
SERVER_TEST_REPORT="$RESULT_DIR/full.json" \
    bash ../scripts/run-server-test-command.sh --dry-run \
    --reporter ../scripts/ci/server-test-reporter.mjs >/dev/null

mapfile -t FILES < <(node --input-type=module - "$RESULT_DIR/full.json" "$INDEX" "$TOTAL" <<'NODE'
import fs from "node:fs";
const [report, indexText, totalText] = process.argv.slice(2);
const files = [...new Set(JSON.parse(fs.readFileSync(report)).tests.map(test => test.file))].sort();
const index = Number(indexText) - 1, total = Number(totalText);
for (let position = 0; position < files.length; position++) {
    if (position % total === index) console.log(files[position]);
}
NODE
)

status=0
if ((${#FILES[@]} == 0)); then
    echo "Shard $SHARD selected no tests" >&2
    status=2
else
    SERVER_TEST_FILES_ONLY=1 SERVER_TEST_REPORT="$RESULT_DIR/executed.json" \
        bash ../scripts/run-server-test-command.sh --reporter ../scripts/ci/server-test-reporter.mjs "${FILES[@]}" || status=$?
fi
node --input-type=module - "$RESULT_DIR/outcome.json" "$SHARD" "$status" <<'NODE'
import fs from "node:fs";
const [file, shard, status] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
    shard, status: Number(status), runId: process.env.GITHUB_RUN_ID ?? "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local", commit: process.env.GITHUB_SHA ?? "local",
}, undefined, 2));
NODE
exit 0
