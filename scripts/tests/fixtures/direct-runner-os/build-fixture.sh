#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 IMAGE CONTEXT [docker build arguments...]" >&2
  exit 2
fi

image=$1
context=$2
shift 2

# GitHub's cache backend is available only through Buildx. Keep the ordinary
# docker build path for local runs so this regression has no CI-only runtime
# dependency. The scope is deliberately dedicated to fixture provisioning:
# scenario package/browser acquisition still happens in fresh containers.
if [ -n "${DIRECT_RUNNER_OS_CACHE_SCOPE:-}" ]; then
  printf 'fixture-build cache=gha scope=%s\n' "$DIRECT_RUNNER_OS_CACHE_SCOPE"
  exec docker buildx build \
    --load \
    --cache-from "type=gha,scope=${DIRECT_RUNNER_OS_CACHE_SCOPE}" \
    --cache-to "type=gha,mode=max,scope=${DIRECT_RUNNER_OS_CACHE_SCOPE}" \
    "$@" -t "$image" "$context"
fi

printf 'fixture-build cache=local-default\n'
exec docker build "$@" -t "$image" "$context"
