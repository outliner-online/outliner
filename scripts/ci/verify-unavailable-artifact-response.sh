#!/bin/bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <request-exit> <http-status> <artifact-id>" >&2
  exit 64
fi

request_exit="$1"
http_status="$2"
artifact_id="$3"

if ! [[ "$request_exit" =~ ^[0-9]+$ ]] || [ "$request_exit" -eq 0 ]; then
  echo "unavailable artifact request unexpectedly succeeded for artifact $artifact_id" >&2
  exit 1
fi

if [ "$http_status" != 404 ]; then
  echo "unavailable artifact request returned HTTP ${http_status:-none}, not 404, for artifact $artifact_id" >&2
  exit 1
fi

if ! [[ "$artifact_id" =~ ^[0-9]+$ ]]; then
  echo "unavailable artifact identity is not numeric" >&2
  exit 1
fi

printf 'artifact %s was rejected as unavailable with HTTP 404\n' "$artifact_id"
