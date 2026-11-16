# Standalone Schedule Hosting contract (#5945)

Run `bash scripts/test-schedule-page-hosting.sh` from the repository root with the
locked root/client/Functions dependencies, Node 22 and the pinned Firebase CLI.
The static fixture mounts the actual `/schedule` page component, reloads through
Hosting's SPA fallback and restores a real SDK emulator session. There is no
SvelteKit server/proxy. All data/users are private fixtures in the isolated
`demo-schedule-contract` Auth/Firestore/Functions/Hosting emulators.

The canonical `scripts/test.sh` runs the dedicated real-boundary spec using
`playwright.schedule-page-hosting.config.ts`, then the existing intercepted visual
spec separately. Only the former proves Hosting-to-Function integration. Known and
empty results require an issued authenticated JSON response and unchanged stored
state before rendering is accepted. Missing and invalid body credentials reach
the actual Function and are rejected distinctly; real Hosting HTML cannot satisfy
the successful-read oracle. A pre-existing private emulator email/password user
is seeded only for the legacy visual spec. No token value is exported by fixtures.
The normal CI shards do not automatically run the dedicated configuration. This
is nonproduction evidence, not Google popup or deployed authenticated API proof.
