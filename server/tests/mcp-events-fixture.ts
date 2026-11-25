import { Hocuspocus } from "@hocuspocus/server";
import Database from "better-sqlite3";
import express from "express";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type https from "node:https";
import type { TLSSocket } from "node:tls";
import { Webhook } from "standardwebhooks";
import request from "supertest";
import { createMcpRouter } from "../src/mcp/mcp-api.js";
import type { OutlinerReadService } from "../src/mcp/outliner-read-service.js";
import { CredentialEnvelope } from "../src/notifications/credential-envelope.js";
import { createNotificationHttpsSender } from "../src/notifications/https-transport.js";
import { NotificationEventsService } from "../src/notifications/mcp-events-service.js";
import { McpLeaseStore } from "../src/notifications/mcp-lease-store.js";
import { NotificationObservationRuntime } from "../src/notifications/observation-runtime.js";
import { NotificationSettingsService } from "../src/notifications/settings-service.js";
import { NotificationSettingsStore } from "../src/notifications/settings-store.js";
import { ViewObservationService } from "../src/notifications/view-observation.js";
import { signAccessToken } from "../src/oauth/tokens.js";

export const KEY = Buffer.alloc(32, 3).toString("base64");
export const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
export const URL = "https://events.example.com/callback";
export const tuple = { name: "outliner.changed", arguments: {}, delivery: { mode: "webhook", url: URL } };
export const subscription = { ...tuple, delivery: { ...tuple.delivery, secret: SECRET } };
export const token = (uid = "owner", clientId = "chatgpt", ttlSeconds = 3600, scope = "outliner.read") =>
    signAccessToken({ uid, clientId, ttlSeconds, scope }).token;
export function decode(response: request.Response) {
    return response.body?.jsonrpc
        ? response.body
        : JSON.parse(response.text.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? "{}");
}
export async function rpc(app: express.Express, method: string, params: Record<string, unknown>, bearer = token()) {
    const call = request(app).post("/mcp").set("Authorization", `Bearer ${bearer}`)
        .set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", method)
        .set("Accept", "application/json, text/event-stream");
    if (method === "tools/call" && typeof params.name === "string") call.set("MCP-Name", params.name);
    return decode(await call.send({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
            ...params,
            _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                ...(params._meta as object ?? {}),
            },
        },
    }));
}
/** Controlled network boundary only. All URL/DNS/TLS, signing, challenge, final-write and outcome decisions remain production code. */
export function receiver() {
    const bodies: { body: any; headers: Record<string, string>; bytes: Buffer; }[] = [];
    let beforeTls: (() => Promise<void>) | undefined;
    let beforeWrite: (() => void) | undefined;
    let eventReply: (() => Promise<void>) | undefined;
    let challengeReply: (() => Promise<void>) | undefined;
    let responseStatus = 204;
    let loseResponse = false;
    let validChallenge = true;
    let throwAfterWrite = false;
    let requests = 0;
    class Socket extends EventEmitter {
        authorized = true;
        remoteAddress = "8.8.8.8";
        remotePort = 443;
        destroy() {
            return this;
        }
    }
    const sender = createNotificationHttpsSender({
        resolve4: async () => {
            await beforeTls?.();
            return ["8.8.8.8"];
        },
        connectTls: () => {
            const socket = new Socket();
            setImmediate(() => socket.emit("secureConnect"));
            return socket as unknown as TLSSocket;
        },
        requestHttps: ((options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
            requests++;
            const req = new EventEmitter() as EventEmitter & { end(body: Buffer): unknown; destroy(): unknown; };
            req.destroy = () => req;
            req.end = (bytes: Buffer) => {
                const body = JSON.parse(bytes.toString());
                const headers = options.headers as Record<string, string>;
                new Webhook(SECRET).verify(bytes, headers);
                bodies.push({ body, headers, bytes: Buffer.from(bytes) });
                if (!body.challenge && throwAfterWrite) throw new Error("write threw after possible transmission");
                void (async () => {
                    if (body.challenge) await challengeReply?.();
                    else await eventReply?.();
                    if (!body.challenge && loseResponse) {
                        req.emit("error", new Error("lost response"));
                        return;
                    }
                    const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy(): unknown; };
                    res.statusCode = body.challenge ? 200 : responseStatus;
                    res.destroy = () => res;
                    callback(res as unknown as IncomingMessage);
                    if (body.challenge) {
                        res.emit("data",
                            Buffer.from(JSON.stringify({ challenge: validChallenge ? body.challenge : "wrong" })));
                    }
                    res.emit("end");
                })();
                return req;
            };
            beforeWrite?.();
            return req as unknown as ClientRequest;
        }) as typeof import("node:https").request,
    });
    return {
        sender,
        bodies,
        get requests() {
            return requests;
        },
        set beforeTls(value: typeof beforeTls) {
            beforeTls = value;
        },
        set beforeWrite(value: typeof beforeWrite) {
            beforeWrite = value;
        },
        set eventReply(value: typeof eventReply) {
            eventReply = value;
        },
        set challengeReply(value: typeof challengeReply) {
            challengeReply = value;
        },
        set responseStatus(value: number) {
            responseStatus = value;
        },
        set loseResponse(value: boolean) {
            loseResponse = value;
        },
        set throwAfterWrite(value: boolean) {
            throwAfterWrite = value;
        },
        set validChallenge(value: boolean) {
            validChallenge = value;
        },
    };
}
export function mount(events: NotificationEventsService, settings?: NotificationSettingsService) {
    const app = express();
    app.use(express.json());
    app.use(
        createMcpRouter({} as OutlinerReadService, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, settings, events),
    );
    return app;
}
export function eventsFixture(db = new Database(":memory:")) {
    const settings = new NotificationSettingsService(new NotificationSettingsStore(() => db), {
        assertTarget: async () => {},
        listTargets: async () => [],
    });
    const runtime = new NotificationObservationRuntime(settings,
        new ViewObservationService(new Hocuspocus(), async () => false), async () => false);
    const store = new McpLeaseStore(() => db, new CredentialEnvelope(KEY));
    const network = receiver();
    const events = new NotificationEventsService(store, runtime, network.sender);
    const app = mount(events, settings);
    return {
        db,
        runtime,
        settings,
        store,
        network,
        events,
        app,
        async close() {
            await events.close();
            await runtime.close();
            if (db.open) db.close();
        },
    };
}
export function held() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => resolve = r);
    return { promise, resolve };
}
