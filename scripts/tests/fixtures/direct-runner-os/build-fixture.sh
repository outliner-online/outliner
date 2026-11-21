#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 IMAGE CONTEXT [docker build arguments...]" >&2
  exit 2
fi

image=$1
context=$2
shift 2

printf 'fixture-build cache=local-default\n'
exec docker build "$@" -t "$image" "$context"
