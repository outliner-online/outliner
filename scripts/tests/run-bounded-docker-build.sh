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
sleep "$setup_timeout" &
setup_timer_pid=$!

# The parent owns the setup-to-case transition. Check the execution receipt
# before the timer on every pass (and once more after the timer expires), so a
# case that has started can never be terminated by a competing watchdog.
case_started=false
while kill -0 "$build_pid" 2>/dev/null; do
    if grep -Fq 'NEGATIVE_CASE_PHASE_STARTED' "$log"; then
        case_started=true
        break
    fi
    if ! kill -0 "$setup_timer_pid" 2>/dev/null; then
        break
    fi
    sleep 0.1
done
kill "$setup_timer_pid" 2>/dev/null || true
wait "$setup_timer_pid" 2>/dev/null || true

if [[ $case_started == false ]] && grep -Fq 'NEGATIVE_CASE_PHASE_STARTED' "$log"; then
    case_started=true
fi
if [[ $case_started == false ]] && kill -0 "$build_pid" 2>/dev/null; then
    : >"$setup_expired"
    terminate_build "$build_pid"
fi

if [[ $case_started == true ]] && kill -0 "$build_pid" 2>/dev/null; then
    sleep "$case_timeout" &
    case_timer_pid=$!
    while kill -0 "$build_pid" 2>/dev/null && kill -0 "$case_timer_pid" 2>/dev/null; do
        sleep 0.1
    done
    if ! kill -0 "$case_timer_pid" 2>/dev/null && kill -0 "$build_pid" 2>/dev/null; then
        : >"$case_expired"
        terminate_build "$build_pid"
    fi
    kill "$case_timer_pid" 2>/dev/null || true
    wait "$case_timer_pid" 2>/dev/null || true
fi

wait "$build_pid"
status=$?
set -e

if [[ -e $setup_expired || -e $case_expired ]]; then
    exit 124
fi
exit "$status"
