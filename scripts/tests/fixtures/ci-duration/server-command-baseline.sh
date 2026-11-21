# Source: 30f1495475a2c1a48c2750360bacfd3509372199:scripts/run-server-tests.sh
cd "$ROOT_DIR/server"

# Use ts-node/esm loader to handle TypeScript imports in ESM environment.
# pin-server-deps.mjs additionally forces bare `yjs` imports (server/src and the
# co-compiled ../shared/src both use them) onto server/node_modules, so the two
# halves share one Yjs instance even while shared/node_modules is symlinked to
# the client. See the header comment in that file.
# PGlite keeps its WASM message channel alive after close(), even though every
# test and database cleanup promise has completed. Mocha's --exit terminates
# that idle runtime handle after reporting the complete suite; it does not skip
# tests or shorten their timeout.
TS_NODE_TRANSPILE_ONLY=1 \
    NODE_OPTIONS="--loader ts-node/esm --loader ./tests/loaders/pin-server-deps.mjs --no-warnings" \
    npx mocha "tests/**/*.test.{js,cjs,ts}" --exclude "tests/cloud-production-entrypoint.test.ts" --exclude "tests/metrics.test.ts" --exclude "tests/metrics-endpoint.test.ts" --exclude "tests/idle-timeout-reconnect.test.ts" --exclude "tests/hocuspocus-server.test.ts" --exclude "tests/log-service.test.ts" --exclude "tests/hocuspocus-auth-bypass.test.ts" --exclude "tests/connection-limits.test.ts" --exclude "tests/security.test.ts" --exclude "tests/seed-api-validation.test.ts" --exclude "tests/project-directory.test.ts" --exclude "tests/project-directory-provider.test.ts" --exclude "tests/project-directory-websocket.test.ts" --timeout 10000 --exit
