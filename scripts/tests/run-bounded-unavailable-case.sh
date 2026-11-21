#!/usr/bin/env bash

set -euo pipefail

if (( $# != 5 )); then
    echo "usage: $0 LAUNCH_ALLOWANCE INNER_WATCHDOG SHUTDOWN_GRACE LOG IMAGE" >&2
    exit 64
fi

launch_allowance=$1
inner_watchdog=$2
shutdown_grace=$3
log=$4
image=$5
docker_bin=${DOCKER_BIN:-docker}

for bound in "$launch_allowance" "$inner_watchdog" "$shutdown_grace"; do
    if [[ ! $bound =~ ^[1-9][0-9]*$ ]]; then
        echo "watchdog bounds must be positive integers" >&2
        exit 64
    fi
done

control=$(mktemp -d)
container_pid=
cleanup() {
    if [[ -n $container_pid ]]; then
        kill -KILL "$container_pid" 2>/dev/null || true
        wait "$container_pid" 2>/dev/null || true
    fi
    rm -rf "$control"
}
trap cleanup EXIT

terminate_container() {
    kill -TERM "$container_pid" 2>/dev/null || return 0
    for _ in {1..10}; do
        kill -0 "$container_pid" 2>/dev/null || return 0
        sleep 0.1
    done
    kill -KILL "$container_pid" 2>/dev/null || true
}

set +e
"$docker_bin" run --rm -v "$control:/run/outliner-apt-control" "$image" >"$log" 2>&1 &
container_pid=$!
sleep "$launch_allowance" &
launch_timer=$!

# The container signals readiness before it can observe admission. This shared
# filesystem handshake does not depend on Docker stdout delivery.
while kill -0 "$container_pid" 2>/dev/null && kill -0 "$launch_timer" 2>/dev/null; do
    [[ -e $control/ready ]] && break
    sleep 0.1
done
kill "$launch_timer" 2>/dev/null || true
wait "$launch_timer" 2>/dev/null || true

if [[ ! -e $control/ready ]]; then
    echo "Container launch exceeded its ${launch_allowance}-second allowance before installer admission." >>"$log"
    terminate_container
    wait "$container_pid" 2>/dev/null
    exit 124
fi

# Only this admission receipt can start the installer and its inner clock.
: >"$control/start"
case_watchdog=$((inner_watchdog + shutdown_grace))
sleep "$case_watchdog" &
case_timer=$!
while kill -0 "$container_pid" 2>/dev/null && kill -0 "$case_timer" 2>/dev/null; do
    sleep 0.1
done
if ! kill -0 "$case_timer" 2>/dev/null && kill -0 "$container_pid" 2>/dev/null; then
    echo "Unavailable case exceeded its ${case_watchdog}-second execution allowance." >>"$log"
    terminate_container
fi
kill "$case_timer" 2>/dev/null || true
wait "$case_timer" 2>/dev/null || true
wait "$container_pid"
status=$?
container_pid=
set -e
exit "$status"
