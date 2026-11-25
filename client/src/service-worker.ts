/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { getLogger } from "./lib/logger";
import { updateEnrollmentBinding } from "./services/notifications/enrollmentBinding";
import {
    handleMobileNotificationClick,
    handleMobilePush,
    type MobileClickEvent,
    type MobileNotificationScope,
    type MobilePushEvent,
} from "./services/notifications/workerNotifications";
const logger = getLogger("ServiceWorker");

import { version } from "$app/env";
import { assets, immutable } from "$app/manifest";
import { asset, resolve } from "$app/paths";

const CACHE_NAME = `outliner-cache-${version}`;
// App shell, Vite-built immutable files and the contents of `static/`.
// `$app/manifest` paths are relative to the base path, so resolve them into
// the same root-relative URLs the browser requests.
const ASSETS = [
    "/",
    ...immutable.map(file => resolve(file.path)),
    ...assets.map(file => asset(file.path)),
];

// Type definitions to avoid no-undef errors
// Import idb in Service Worker environment

interface SyncServiceWorkerGlobalScope extends MobileNotificationScope {
    clients: MobileNotificationScope["clients"] & { claim(): Promise<void>; };
    skipWaiting(): Promise<void>;
    addEventListener(type: "install", listener: (event: { waitUntil(p: Promise<unknown>): void; }) => void): void;
    addEventListener(type: "activate", listener: (event: { waitUntil(p: Promise<unknown>): void; }) => void): void;
    addEventListener(type: "push", listener: (event: MobilePushEvent) => void): void;
    addEventListener(type: "notificationclick", listener: (event: MobileClickEvent) => void): void;
    addEventListener(
        type: "fetch",
        listener: (event: { request: Request; respondWith(r: Promise<Response> | Response): void; }) => void,
    ): void;
    addEventListener(
        type: "message",
        listener: (event: {
            data: unknown;
            ports: Array<{ postMessage(value: unknown): void; }>;
            waitUntil(p: Promise<unknown>): void;
        }) => void,
    ): void;
}

declare const self: SyncServiceWorkerGlobalScope;
const WORKER_BOOT_ID = crypto.randomUUID();

self.addEventListener("message", event => {
    if (event.data !== "outliner:read-web-push-binding" || !event.ports[0]) return;
    const port = event.ports[0];
    event.waitUntil(
        updateEnrollmentBinding("read").then(
            binding => port.postMessage({ binding, workerBootId: WORKER_BOOT_ID }),
            () => port.postMessage({ error: "binding_unavailable", workerBootId: WORKER_BOOT_ID }),
        ),
    );
});

self.addEventListener("push", event => handleMobilePush(self, event));
self.addEventListener("notificationclick", event => handleMobileNotificationClick(self, event));

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS).catch(err => {
                logger.warn("Failed to cache some assets:", err);
                // Continue even if caching some assets fails
            });
        }),
    );
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            // Delete old cache
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME) {
                            return caches.delete(cacheName);
                        }
                    }),
                );
            }),
        ]),
    );
});

self.addEventListener("fetch", event => {
    const req = event.request;

    // Do not cache API endpoints
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
        return;
    }

    // Cache handling for GET requests
    if (req.method === "GET") {
        const url = new URL(req.url);

        // Do not cache API responses
        if (url.pathname.startsWith("/api/")) {
            return;
        }

        const isImmutable = url.pathname.startsWith("/_app/immutable/");

        if (req.mode === "navigate" || !isImmutable) {
            // Network-first, fall back to cache when offline
            event.respondWith(
                fetch(req)
                    .then(response => {
                        return response;
                    })
                    .catch(async err => {
                        logger.warn("Fetch failed, trying cache:", err);
                        const cached = await caches.match(req);
                        if (cached) return cached;
                        if (req.mode === "navigate") {
                            const shell = await caches.match("/");
                            if (shell) return shell;
                        }
                        return new Response("Network error", { status: 503 });
                    }),
            );
        } else {
            // Cache-first: the URL already encodes the content hash
            event.respondWith(
                caches.match(req).then(res => {
                    if (res) {
                        return res;
                    }

                    return fetch(req).then(response => {
                        // Cache only if response is normal
                        if (response.status === 200) {
                            const copy = response.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(req, copy).catch(err => {
                                    logger.warn("Failed to cache response:", err);
                                });
                            });
                        }
                        return response;
                    }).catch(err => {
                        logger.warn("Fetch failed, trying cache:", err);
                        return new Response("Network error", { status: 503 });
                    });
                }),
            );
        }
        return;
    }
});
