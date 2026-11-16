# Outliner Firebase Functions

## Overview

This directory contains the Firebase Functions used in the Outliner application.
The main functions are as follows:

1. `/api/save-container` - Endpoint to save user's container ID
2. `/api/get-user-containers` - Endpoint to get the list of container IDs
   accessible by the user
3. `/health` - Health check endpoint
4. `/api/azure-health-check` - Endpoint to check the operation of Azure Fluid
   Relay keys
5. `/api/create-schedule` - Endpoint to register a publishing schedule for a
   specified page
6. `/api/update-schedule` - Endpoint to update an existing schedule
7. `/api/list-schedules` - Endpoint to get a list of schedules created by the
   user
8. `/api/cancel-schedule` - Endpoint to cancel a schedule

### Samples

```bash
curl -X POST http://localhost:57000/api/create-schedule \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"<ID_TOKEN>","pageId":"<PAGE_ID>","schedule":{"strategy":"one_shot","nextRunAt":<TIMESTAMP>}}'

curl -X POST http://localhost:57000/api/cancel-schedule \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"<ID_TOKEN>","pageId":"<PAGE_ID>","scheduleId":"<SCHEDULE_ID>"}'
```

## Setup

1. Install dependencies:

```bash
cd functions
npm install
```

2. Set environment variables:

```bash
cp .env.example .env
```

Edit the `.env` file and set the necessary environment variables:

- Azure Fluid Relay settings (Tenant ID, Endpoint, Primary Key)

## Local Testing

To run Firebase Functions locally:

```bash
npm run serve
```

This starts the Functions emulator, allowing you to test Functions locally.

## Deployment

To deploy Firebase Functions:

```bash
npm run deploy
```

Or, from the project root directory:

```bash
firebase deploy --only functions
```

## Environment Variable Configuration

In the production environment, you need to set environment variables for
Firebase Functions:

```bash
firebase functions:config:set azure.tenant_id="your-tenant-id" azure.endpoint="https://us.fluidrelay.azure.com" azure.primary_key="your-primary-key"
```

## Azure Fluid Relay Health Check

### `/api/azure-health-check`

Endpoint to check the operation of Azure Fluid Relay keys. It allows verifying
if the Azure Fluid Relay settings are working correctly in the production
environment.

**Method**: GET

**Response Example**:

```json
{
  "status": "healthy",
  "timestamp": "2025-07-22T06:45:00.000Z",
  "azure": {
    "config": {
      "tenantId": "configured",
      "endpoint": "configured",
      "primaryKey": "configured",
      "secondaryKey": "configured",
      "activeKey": "primary"
    },
    "tokenTest": {
      "status": "success",
      "error": null,
      "tokenGenerated": true,
      "tokenValid": true
    },
    "connectionTest": {
      "status": "skipped",
      "note": "Connection test requires actual container creation which is not performed in health check"
    }
  },
  "environment": {
    "isEmulator": false,
    "projectId": "outliner-d57b0"
  }
}
```

**Status**:

- `healthy`: All tests passed
- `unhealthy`: Issue with configuration or token generation
- `error`: Unexpected error occurred

## Notes

- Firebase Functions uses Node.js 22 runtime
- Please configure appropriate security rules in the production environment
- Azure Fluid Relay settings must be set as environment variables for Firebase
  Functions

# Isolated Schedule authentication regression

Run `bash scripts/test-schedule-hosting.sh` from the repository root after
installing the locked root, client and Functions dependencies. Use the
repository-pinned Firebase CLI and Node 22. The runner starts only private Auth,
Firestore, Functions and Hosting emulators for `demo-schedule-contract`, using a
fresh HOME and the repository's unchanged Hosting rewrites and Firestore rules.
It never uses a production session. `FIREBASE_EMULATORS_PATH` may select an
existing emulator-binary cache.

The explicit Jest configuration lives in `functions/schedule-hosting.jest.cjs`;
the suite is separate from legacy Functions tests with shared mocks. All five
operations must accept SDK-issued emulator credentials, reject nonempty invalid
credentials separately from missing credentials, and preserve fixture state on
rejection. Missing emulators, HTML or unavailable routes fail the suite.
