# Production Environment Setup Guide

## Required GitHub Secrets

To ensure the application operates correctly in the production environment, you need to configure the following GitHub Secrets.

### Azure Fluid Relay Settings

1. **AZURE_TENANT_ID**
   - Tenant ID for Azure Fluid Relay
   - Example: `your-production-tenant-id`

2. **AZURE_ENDPOINT**
   - Endpoint for Azure Fluid Relay
   - Example: `https://your-production-endpoint.fluidrelay.azure.com`

3. **AZURE_PRIMARY_KEY**
   - Primary key for Azure Fluid Relay
   - Example: `your-production-primary-key`

4. **AZURE_SECONDARY_KEY**
   - Secondary key for Azure Fluid Relay
   - Example: `your-production-secondary-key`

5. **AZURE_ACTIVE_KEY**
   - The key to use ("primary" or "secondary")
   - Usually `primary`

### Firebase Settings

6. **FIREBASE_API_KEY**
   - API Key for the Firebase project

7. **FIREBASE_TOKEN**
   - Token for Firebase CLI deployment

## Current Issues

The following error is occurring in the production environment:

```
[HTTP/1.1 404] /api/fluid-token
[ERROR]: Endpoint not found
```

### Possible Causes

1. **Incorrect Azure Configuration**: Azure settings in GitHub Secrets are incorrect
2. **Key Mismatch**: The key set in Azure Fluid Relay does not match the key in GitHub Secrets
3. **Tenant ID Mismatch**: The Tenant ID for Azure Fluid Relay is incorrect

### Resolution Steps

1. Check Fluid Relay service settings in the Azure Portal
2. Update Azure settings in GitHub Secrets with the correct values
3. Execute deployment to reflect the settings
4. Check Firebase Functions logs to verify if the issue is resolved

### How to Check Logs

You can check Firebase Functions logs with the following command:

```bash
firebase functions:log --project outliner-d57b0
```

Or you can check logs in the "Functions" section of the Firebase Console.

## Troubleshooting

### If 401 Errors Persist

1. Verify that Firebase Authentication is configured correctly
2. Verify that client-side Firebase settings are correct
3. Verify that the ID token is being sent correctly

### If 403 Errors (Invalid token) Persist

1. Verify that the Azure Fluid Relay key matches GitHub Secrets
2. Verify that the Tenant ID is correct
3. Verify that the Azure Fluid Relay service is enabled

## Canonical Hosting origin and cutover verification (#5932)

The application and Firebase Hosting API origin is `https://outliner-online.com`.
The supported deployment build is `cd client && npm run build:production`, which
loads `.env.production` with overload semantics. `.env.firebase` selects the same
origin for explicit Firebase-mode builds. Only `VITE_FIREBASE_FUNCTIONS_URL`
selects the API origin; the unused `VITE_API_BASE_URL` / `VITE_API_SERVER_URL`
production aliases have been removed.

Keep Firebase project `outliner-d57b0`, Auth handler
`outliner-d57b0.firebaseapp.com`, and Google popup sign-in. The browser origin must
be authorized in Firebase Authentication. Yjs remains on the separate
`wss://outliner-yjs-ws.outliner-online.com` host; its server Origin policy is
tracked separately in #5933.

Run these checks sequentially from `client/`:

```bash
npm run build:production
node scripts/check-production-build.mjs
npx playwright test --config playwright.deployed.config.ts firebase-hosting-origin.spec.ts
```

The first check executes the emitted production Functions resolver and inspects
emitted browser configuration, independently of source env values. It rejects a
legacy API origin, changed project/Auth handler, or changed Yjs endpoint. It makes
no live request. The deployed test checks root, a representative deep link, and
read-only `/api/health` with normal certificate validation and no redirect accepted
as success. A TLS error, redirect, HTML fallback at the API endpoint, or an
unexecuted test is not deployed API success. Do not bypass certificates.

After HTTPS succeeds, use an authorized test account in a normal browser on the
canonical origin to complete Google popup sign-in. Inspect a read-only API request
in the Network panel: confirm its canonical origin, existing method/path, JSON
payload and Firebase ID token, and successful JSON response. Do not log or copy
tokens into reports. Do not create/delete production users or projects for this
check. The current helper produces camelCase paths (for example
`/api/listSchedules`) while some Hosting rewrites use kebab-case; report a mismatch
if encountered rather than changing endpoint contracts as part of this cutover.
A no-auth health response cannot prove popup sign-in or authenticated reads.

On 2026-11-15 at 14:56 UTC, certificate-valid HTTPS GETs to `/` and `/api/health`
returned HTTP 200; health returned JSON `status: "OK"`. This supersedes the earlier
certificate-pending observation at issue authoring time, but does not establish
Firebase's management-plane ownership/certificate state, Google popup success,
or an authenticated API read. Record those separately when executed.
