# Schedule service Hosting contract (#5944)

Run `bash scripts/test-schedule-service-hosting.sh` from the repository root with
the locked root/client/Functions dependencies, Node 22 and the pinned Firebase CLI.
This dedicated fixture uses the actual Schedule service and Auth SDK in a static
browser bundle. It runs only against private Auth/Firestore/Functions/Hosting
emulators for `demo-schedule-contract`, never a SvelteKit proxy or public data.
The dedicated Schedule Hosting workflow runs this configuration with private emulators;
normal application shards retain their existing fixture configuration.

The runner invokes canonical `scripts/test.sh` with
`playwright.schedule-service-hosting.config.ts`. The positive oracle observes all
five POST payloads, actual response contracts and Firestore effects (REQ-001–005).
Invalid strings reach the real verifier through Hosting, real static HTML cannot
pass JSON/calendar checks, and controlled transport refusal fails all operations
without mutation (REQ-006). No HTTP response is fulfilled as success. Production
origin/path selection is separately checked by `schedule-hosting-paths.test.ts`;
that is build/configuration evidence, not deployed HTTP evidence.
