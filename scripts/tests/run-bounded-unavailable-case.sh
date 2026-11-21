#!/usr/bin/env bash

set -euo pipefail

if (( $# < 5 )); then
    echo "usage: $0 LAUNCH_ALLOWANCE INNER_WATCHDOG SHUTDOWN_GRACE LOG COMMAND [ARG ...]" >&2
    exit 64
fi

launch_allowance=$1
inner_watchdog=$2
shutdown_grace=$3
log=$4
shift 4

for bound in "$launch_allowance" "$inner_watchdog" "$shutdown_grace"; do
    if [[ ! $bound =~ ^[1-9][0-9]*$ ]]; then
        echo "watchdog bounds must be positive integers" >&2
        exit 64
    fi
done

# The command starts its own inner watchdog after container startup. Compose a
# distinct startup allowance with that watchdog and its possible kill grace so
# the host cannot terminate a legitimate full-duration inner execution first.
host_watchdog=$((launch_allowance + inner_watchdog + shutdown_grace))

set +e
timeout --signal=TERM --kill-after="$shutdown_grace" "$host_watchdog" \
    "$@" >"$log" 2>&1
status=$?
set -e
exit "$status"
