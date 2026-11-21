#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Install dependencies without starting servers
SKIP_SERVER_START=1 SKIP_PORT_WAIT=1 bash "$ROOT_DIR/scripts/setup.sh"

exec bash "$SCRIPT_DIR/run-server-test-command.sh"
