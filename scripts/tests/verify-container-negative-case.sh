#!/usr/bin/env bash

set -euo pipefail

if (( $# != 3 )); then
    echo "usage: $0 CASE BUILD_STATUS LOG" >&2
    exit 64
fi

case_name=$1
build_status=$2
log=$3

if [[ ! "$build_status" =~ ^[0-9]+$ ]]; then
    echo "Invalid build status for ${case_name}: ${build_status}" >&2
    exit 64
fi
if (( build_status == 0 )); then
    echo "Negative control unexpectedly built successfully: ${case_name}" >&2
    exit 1
fi
if (( build_status == 124 || build_status == 137 )); then
    echo "Regression harness timed out before ${case_name} reported its own failure." >&2
    exit 1
fi

installer_status=$(sed -n 's/.*INSTALLER_EXIT_STATUS=\([0-9][0-9]*\).*/\1/p' "$log" | tail -n 1)
if [[ -z "$installer_status" || "$installer_status" == 0 ]]; then
    echo "Negative control lacks a nonzero installer-reported status: ${case_name}" >&2
    exit 1
fi

case "$case_name" in
    unavailable)
        for evidence in \
            'APT acquisition attempt: primary host 127.0.0.1:18081' \
            'APT acquisition failure: primary host 127.0.0.1:18081' \
            'APT acquisition attempt: fallback host 127.0.0.1:18082' \
            'APT acquisition failure: fallback host 127.0.0.1:18082'
        do
            if ! grep -Fq "$evidence" "$log"; then
                echo "Unavailable control lacks endpoint evidence: ${evidence}" >&2
                exit 1
            fi
        done
        ;;
    slow)
        grep -Fq 'exceeded its 5-second aggregate budget' "$log" || {
            echo "Slow control lacks the installer timeout failure." >&2
            exit 1
        }
        ;;
    missing)
        grep -Fq 'Unable to locate package outliner-package-that-does-not-exist' "$log" || {
            echo "Missing-package control lacks the expected APT failure." >&2
            exit 1
        }
        ;;
    *)
        echo "Unknown negative case: ${case_name}" >&2
        exit 64
        ;;
esac
