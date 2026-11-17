#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 SOURCE_DIRECTORY DOWNLOADED_DIRECTORY" >&2
  exit 2
fi

source_directory=$1
downloaded_directory=$2

for evidence_file in execution.json runtime.log; do
  if [ ! -f "${source_directory}/${evidence_file}" ]; then
    echo "source evidence is missing: ${evidence_file}" >&2
    exit 1
  fi
  if [ ! -f "${downloaded_directory}/${evidence_file}" ]; then
    echo "downloaded evidence is missing: ${evidence_file}" >&2
    exit 1
  fi
  if ! cmp --silent "${source_directory}/${evidence_file}" "${downloaded_directory}/${evidence_file}"; then
    echo "downloaded evidence differs: ${evidence_file}" >&2
    exit 1
  fi
done
