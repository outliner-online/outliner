#!/usr/bin/env bash
# Strict direct-runner CI boundary. Local setup.sh retains its degraded mode.
set -euo pipefail
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export ROOT_DIR

if [ "${1:-}" = "--worker" ]; then
  source "$ROOT_DIR/scripts/common-functions.sh"
  export DIRECT_RUNNER_OS_STRICT=1
  direct_runner_stage prerequisites
  if [ "${SKIP_APT_INSTALL:-0}" = "1" ]; then
    echo "Error: direct-runner setup cannot skip required OS acquisition." >&2
    exit 1
  fi
  browser=${E2E_BROWSER:-chromium}
  case "$browser" in chromium|firefox) ;; *) echo "Unsupported browser: $browser" >&2; exit 1 ;; esac
  pinned=$(playwright_pinned_version)
  if [ -z "$pinned" ]; then echo "Cannot read locked Playwright version." >&2; exit 1; fi
  for package in @playwright/test playwright playwright-core; do
    installed=$(node -p "require('$ROOT_DIR/client/node_modules/$package/package.json').version")
    if [ "$installed" != "$pinned" ]; then
      echo "Locked Playwright mismatch: $package installed=$installed expected=$pinned" >&2
      exit 1
    fi
  done
  unset E2E_MIRROR_OFFLINE_READY
  direct_runner_stage mirror-profile-and-acquisition
  mirror_status=0
  direct_runner_root env PATH="$PATH" LC_ALL=C DEBIAN_FRONTEND=noninteractive \
    /usr/bin/python3 "$ROOT_DIR/scripts/ci/ubuntu_mirror_download.py" \
    --browser "$browser" --deadline-ms "${E2E_OS_WORK_DEADLINE:-}" || mirror_status=$?
  case "$mirror_status" in
    0) export E2E_MIRROR_OFFLINE_READY=1 ;;
    78) echo "APT mirror profile unsupported/target absent; using existing setup." ;;
    *) exit "$mirror_status" ;;
  esac
  install_os_utilities --os-only
  # Always required, even on a browser-cache hit. Never use cache as OS evidence.
  apt_is_available
  direct_runner_stage "playwright-install-deps ($browser, $pinned)"
  # Start the pinned CLI inside the privileged supervisor. It then installs
  # directly as root instead of introducing another unsupervised sudo boundary.
  if [ "${E2E_MIRROR_OFFLINE_READY:-0}" = 1 ]; then
    # The same installed locked SDK native declarations supplied acquisition.
    packages=$(node "$ROOT_DIR/scripts/ci/mirror-browser-packages.cjs" "$ROOT_DIR" "$browser")
    mapfile -t required_sdk < <(printf '%s' "$packages" | /usr/bin/python3 -c 'import json,sys;print("\n".join(json.load(sys.stdin)["packages"]))')
    [ "${#required_sdk[@]}" -gt 0 ] || exit 64
    verify_required_os_packages "${required_sdk[@]}"
  else
    direct_runner_root "$(command -v node)" "$ROOT_DIR/client/node_modules/playwright/cli.js" install-deps "$browser"
  fi
  # Check again after Playwright's package transaction, before browser readiness.
  install_os_utilities --os-only
  direct_runner_stage "playwright-browser ($browser, $pinned)"
  ensure_playwright_browsers "$browser"
  direct_runner_stage ready
  exit 0
fi

# Includes all probes, APT retries, repair, install-deps and browser preparation.
# 595s work + at most 5s TERM-to-KILL grace = 600s, below the 30m E2E job.
# The outer timeout bounds the unprivileged worker/browser preparation; each
# privileged acquisition also has a root-owned supervisor using this deadline.
budget=${E2E_OS_BUDGET_SECONDS:-600}
if ! [[ "$budget" =~ ^[0-9]{1,3}$ ]]; then
  echo "E2E_OS_BUDGET_SECONDS must be an integer from 6 through 600." >&2
  exit 64
fi
budget=$((10#$budget))
if (( budget < 6 || budget > 600 )); then
  echo "E2E_OS_BUDGET_SECONDS must be an integer from 6 through 600." >&2
  exit 64
fi
command -v timeout >/dev/null || { echo "GNU timeout is required for direct-runner setup." >&2; exit 1; }
E2E_OS_STAGE_FILE=$(mktemp)
export E2E_OS_STAGE_FILE
trap 'rm -f "$E2E_OS_STAGE_FILE"' EXIT
printf '%s\n' starting > "$E2E_OS_STAGE_FILE"
started=$SECONDS
# CLOCK_MONOTONIC has one boot-relative epoch across Linux processes/uids.
# Wall time is for diagnostics only; never translate or renew this deadline.
now=$(/usr/bin/python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
export E2E_OS_WORK_DEADLINE=$((now + (budget - 5) * 1000))
status=0
timeout --signal=TERM --kill-after=5 "$((budget - 5))" bash "$0" --worker || status=$?
stage=$(cat "$E2E_OS_STAGE_FILE")
echo "Direct-runner setup outcome: stage=$stage exit=$status elapsed=$((SECONDS - started))s aggregate-budget=${budget}s"
if (( status != 0 )); then
  echo "Error: direct-runner OS/browser setup failed; tests are not ready (timeout exits: 124/137)." >&2
fi
exit "$status"
