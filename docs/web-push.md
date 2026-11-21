# Web Push enrollment

Cloud deployments can let a signed-in user enroll the current secure-context browser from **Settings → Smartphone notifications**. Supported iOS/iPadOS browsers require the site to be installed on the Home Screen. Enrollment requires the existing service worker and a browser implementation of the Push API.

Configure one stable VAPID identity with `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT` (an HTTPS URL or `mailto:` contact). Missing or invalid configuration is shown as unavailable; Outliner never generates keys at startup.

The settings screen distinguishes unsupported browsers, denied permission, unavailable service configuration, enrollment in progress, registered, disabled, failed, and incomplete cleanup. A registered device means only that its private destination was committed by the server. It does **not** demonstrate that a handset received a notification.

Each account may retain 16 active browser registrations and 32 total active or inactive records. Disabling removes the browser subscription where possible and invalidates server registration. Outliner does not queue enrollment or disable requests for offline replay.
