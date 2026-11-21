#!/usr/bin/env bash

set -euo pipefail

if (( $# < 4 )); then
    echo "usage: $0 SETUP_TIMEOUT CASE_TIMEOUT LOG COMMAND [ARG ...]" >&2
    exit 64
fi

setup_timeout=$1
case_timeout=$2
log=$3
shift 3
setup_expired="${log}.setup-expired"
case_expired="${log}.case-expired"

terminate_build() {
    local pid=$1
    kill -TERM "$pid" 2>/dev/null || return 0
    for _ in {1..10}; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
}

set +e
"$@" >"$log" 2>&1 &
build_pid=$!
(
    sleep "$setup_timeout"
    if kill -0 "$build_pid" 2>/dev/null; then
        : >"$setup_expired"
        terminate_build "$build_pid"
    fi
) &
setup_watchdog_pid=$!

while kill -0 "$build_pid" 2>/dev/null && \
    ! grep -Fq 'NEGATIVE_CASE_PHASE_STARTED' "$log" && \
    [[ ! -e $setup_expired ]]
do
    sleep 0.1
done
kill "$setup_watchdog_pid" 2>/dev/null || true
wait "$setup_watchdog_pid" 2>/dev/null || true

if grep -Fq 'NEGATIVE_CASE_PHASE_STARTED' "$log"; then
    (
        sleep "$case_timeout"
        if kill -0 "$build_pid" 2>/dev/null; then
            : >"$case_expired"
            terminate_build "$build_pid"
        fi
    ) &
    case_watchdog_pid=$!
else
    case_watchdog_pid=
fi

wait "$build_pid"
status=$?
if [[ -n $case_watchdog_pid ]]; then
    kill "$case_watchdog_pid" 2>/dev/null || true
    wait "$case_watchdog_pid" 2>/dev/null || true
fi
set -e

if [[ -e $setup_expired || -e $case_expired ]]; then
    exit 124
fi
exit "$status"
