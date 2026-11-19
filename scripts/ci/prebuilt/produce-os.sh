#!/usr/bin/env bash
# Disposable image build ONLY; never called by the default direct-runner path.
set -euo pipefail
ROOT_DIR=/prepared/source
export ROOT_DIR
mkdir -p "$ROOT_DIR/job_logs"
if [ "${1:-}" = --worker ]; then
  source "$ROOT_DIR/scripts/common-functions.sh"
  export DIRECT_RUNNER_OS_STRICT=1
  trap 'result=$?; printf "Prepared OS outcome: stage=%s exit=%s\n" "$(cat "$E2E_OS_STAGE_FILE")" "$result"; exit "$result"' EXIT
  direct_runner_stage apt-update
  apt_is_available
  direct_runner_stage java-and-tools
  retry_apt_get -y install --no-install-recommends openjdk-21-jre-headless xvfb lsof netcat-openbsd curl sudo python3-venv python3-pip git-lfs
  install_os_utilities --os-only
  for browser in chromium firefox; do
    # Version-fenced declarations are required BEFORE the SDK installer executes.
    node "$ROOT_DIR/scripts/locked-browser-os-packages.cjs" "$ROOT_DIR" "$browser" > "/tmp/locked-$browser.json"
    direct_runner_stage "playwright-install-deps-$browser"
    direct_runner_root node "$ROOT_DIR/client/node_modules/playwright/cli.js" install-deps "$browser"
  done
  install_os_utilities --os-only
  direct_runner_stage locked-browser-assets
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 direct_runner_root node "$ROOT_DIR/client/node_modules/playwright/cli.js" install chromium firefox
  direct_runner_stage real-browser-check
  node "$ROOT_DIR/scripts/ci/prebuilt/check_browsers.cjs" "$ROOT_DIR"
  direct_runner_stage complete
  exit 0
fi
# Same aggregate:595 seconds work +5 grace. NOT two single-browser budgets.
export E2E_OS_WORK_DEADLINE=$(($(date +%s%3N) + 595000))
export E2E_OS_STAGE_FILE=/tmp/prepared-os-stage
printf starting > "$E2E_OS_STAGE_FILE"
status=0
timeout --signal=TERM --kill-after=5 595 bash "$0" --worker || status=$?
printf 'Prepared OS aggregate exit=%s budget=600s\n' "$status"
exit "$status"
