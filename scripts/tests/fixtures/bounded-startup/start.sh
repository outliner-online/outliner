#!/usr/bin/env bash
# Isolated executable at the production startup-command boundary.
set -euo pipefail
attempt=$(cat attempts 2>/dev/null || printf 0)
attempt=$((attempt + 1))
printf '%s' "$attempt" > attempts
export attempt
startup_phase pre_readiness
python3 -u scripts/control.py prepare
startup_phase readiness
python3 -u scripts/control.py ready
startup_phase post_readiness
python3 -u scripts/control.py finish
