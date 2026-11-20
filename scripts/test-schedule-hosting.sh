#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/outliner-schedule.XXXXXXXX")"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/public"
printf '<!doctype html><title>Private Schedule fixture</title>' > "$fixture/public/index.html"
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
  FIREBASE_CLI_DISABLE_UPDATE_CHECK=true \
  FIREBASE_EMULATORS_PATH="${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}" \
  node scripts/firebase-cli-npm.cjs emulators:exec --project demo-schedule-contract \
  --config "$fixture/firebase.json" --only auth,firestore,functions,hosting \
  'npm --prefix functions test -- --config schedule-hosting.jest.cjs --runInBand'
