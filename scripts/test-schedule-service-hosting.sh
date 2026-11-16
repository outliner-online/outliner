#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/outliner-schedule.XXXXXXXX")"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/public"
mkdir -p "$fixture/home"
(cd "$repo/client" && env -i HOME="$fixture/home" PATH="$PATH" SCHEDULE_HOSTING_BUILD_DIR="$fixture/public" \
  VITE_USE_FIREBASE_EMULATOR=true VITE_FIREBASE_API_KEY=emulator-only \
  VITE_FIREBASE_AUTH_DOMAIN=demo-schedule-contract.firebaseapp.com \
  VITE_FIREBASE_PROJECT_ID=demo-schedule-contract VITE_FIREBASE_STORAGE_BUCKET=demo-schedule-contract.appspot.com \
  VITE_FIREBASE_MESSAGING_SENDER_ID=123456789 VITE_FIREBASE_APP_ID=emulator-only \
  VITE_FIREBASE_EMULATOR_HOST=127.0.0.1 VITE_AUTH_EMULATOR_PORT=59199 \
  ./node_modules/.bin/vite build --config e2e/fixtures/schedule-service-hosting/vite.config.ts --mode schedule-contract)

# Keep the repository's actual rewrite table. Only local fixture/port selection differs.
node - "$repo" "$fixture" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [repo, fixture] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(repo, "firebase.json")));
config.functions = [{ source: path.relative(fixture, path.join(repo, "functions")), runtime: "nodejs22" }];
config.hosting.public = "public";
fs.copyFileSync(path.join(repo, "firestore.rules"), path.join(fixture, "firestore.rules"));
config.firestore.rules = "firestore.rules";
fs.copyFileSync(path.join(repo, "firestore.indexes.json"), path.join(fixture, "firestore.indexes.json"));
config.firestore.indexes = "firestore.indexes.json";
delete config.storage;
config.emulators = {
  auth: {host:"127.0.0.1",port:59199}, firestore:{host:"127.0.0.1",port:58180},
  functions:{host:"127.0.0.1",port:57170}, hosting:{host:"127.0.0.1",port:57100},
  hub:{host:"127.0.0.1",port:54100}, logging:{host:"127.0.0.1",port:54101},
  ui:{enabled:false}, singleProjectMode:true,
};
fs.writeFileSync(path.join(fixture, "firebase.json"), JSON.stringify(config));
JS
cd "$repo"
mkdir -p "$fixture/home"
env -i HOME="$fixture/home" PATH="$PATH" CI=true SENTRY_DSN= \
  FIREBASE_CLI_DISABLE_UPDATE_CHECK=true XDG_CACHE_HOME="$fixture/cache" PWTEST_CACHE_DIR="$fixture/playwright-cache" \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" \
  FIREBASE_EMULATORS_PATH="${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}" \
  node scripts/firebase-cli-npm.cjs emulators:exec --project demo-schedule-contract \
  --config "$fixture/firebase.json" --only auth,firestore,functions,hosting \
  'SKIP_AUTO_SETUP=1 bash scripts/test.sh client/e2e/hosting-schedule/sch-service-hosting-contract-4d23a6b8.spec.ts -- --config=playwright.schedule-service-hosting.config.ts'
