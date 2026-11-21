import { expect } from "chai";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type https from "node:https";
import type { TLSSocket } from "node:tls";
import {
    createNotificationHttpsSender,
    type HeaderProfile,
    type HttpsPost,
    type NotificationTransportDependencies,
} from "../src/notifications/https-transport.js";
import { createMcpCallbackVerifier } from "../src/notifications/mcp-webhook.js";

const PUBLIC_ADDRESS = "8.8.8.8";

class ControlledSocket extends EventEmitter {
    authorized = true;
    remoteAddress = PUBLIC_ADDRESS;
    remotePort = 443;
    destroyed = false;
    destroy() {
        this.destroyed = true;
        return this;
    }
}

class ControlledResponse extends EventEmitter {
    destroyed = false;
    readonly statusCode: number;
    constructor(statusCode: number) {
        super();
        this.statusCode = statusCode;
    }
    destroy(error?: Error) {
        this.destroyed = true;
        if (error) queueMicrotask(() => this.emit("error", error));
        return this;
    }
}

class ControlledRequest extends EventEmitter {
    destroyed = false;
    ended = false;
    body?: Buffer;
    private readonly respond: (body: Buffer) => { status: number; body?: Buffer; };
    constructor(respond: (body: Buffer) => { status: number; body?: Buffer; }) {
        super();
        this.respond = respond;
    }
    end(body: Buffer) {
        this.ended = true;
        this.body = Buffer.from(body);
        const result = this.respond(this.body);
        const response = new ControlledResponse(result.status);
        this.emit("response", response);
        queueMicrotask(() => {
            if (result.body) response.emit("data", result.body);
            response.emit("end");
        });
        return this;
    }
    destroy() {
        this.destroyed = true;
        return this;
    }
}

type FixtureOptions = {
    authorized?: boolean;
    remoteAddress?: string;
    response?: (body: Buffer) => { status: number; body?: Buffer; };
};

function transportFixture(options: FixtureOptions = {}) {
    const socket = new ControlledSocket();
    socket.authorized = options.authorized ?? true;
    socket.remoteAddress = options.remoteAddress ?? PUBLIC_ADDRESS;
    let request: ControlledRequest | undefined;
    let requestOptions: https.RequestOptions | undefined;
    const dependencies: NotificationTransportDependencies = {
        resolve4: async () => [PUBLIC_ADDRESS],
        connectTls: (tlsOptions) => {
            expect(tlsOptions).to.include({
                host: PUBLIC_ADDRESS,
                port: 443,
                servername: "events.example.com",
                rejectUnauthorized: true,
            });
            queueMicrotask(() => socket.emit("secureConnect"));
            return socket as unknown as TLSSocket;
        },
        requestHttps: ((httpsOptions: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
            requestOptions = httpsOptions;
            request = new ControlledRequest(options.response ?? (() => ({ status: 204 })));
            request.once("response", (response) => callback(response as unknown as IncomingMessage));
            return request as unknown as ClientRequest;
        }) as typeof import("node:https").request,
    };
    return {
        send: createNotificationHttpsSender(dependencies),
        socket,
        get request() {
            return request;
        },
        get requestOptions() {
            return requestOptions;
        },
    };
}

function post(profile: HeaderProfile, beforeSend: HttpsPost["beforeSend"], deadline = Date.now() + 1_000): HttpsPost {
    return {
        url: "https://events.example.com/callback?opaque=1",
        headerProfile: profile,
        responseMode: "status",
        authorizationDeadlineMs: deadline,
        canStart: () => true,
        beforeSend,
    };
}

const mcpHeaders = {
    "content-type": "application/json",
    "webhook-id": "evt_1",
    "webhook-timestamp": "1700000000",
    "webhook-signature": "v1,signature",
    "x-mcp-subscription-id": "sub_1",
};

function prepared(headers: Readonly<Record<string, string>> = mcpHeaders) {
    return Promise.resolve({ body: Buffer.from("exact-body"), headers, isCurrent: () => true });
}

describe("notification HTTPS exported transport boundary", () => {
    it("applies the absolute deadline to a never-settling beforeSend and destroys the verified socket", async () => {
        const fixture = transportFixture();
        const outcome = await fixture.send(post("mcp-events", () => new Promise(() => {}), Date.now() + 25));
        expect(outcome).to.deep.equal({ kind: "unknown", reason: "deadline", writeInitiated: false });
        expect(fixture.request).to.equal(undefined);
        expect(fixture.socket.destroyed).to.equal(true);
    });

    it("refuses TLS identity and connected-peer failures before creating a request", async () => {
        for (const options of [{ authorized: false }, { remoteAddress: "1.1.1.1" }]) {
            const fixture = transportFixture(options);
            expect(await fixture.send(post("mcp-events", () => prepared()))).to.deep.equal({
                kind: "rejected",
                reason: "tls",
                writeInitiated: false,
            });
            expect(fixture.request).to.equal(undefined);
            expect(fixture.socket.destroyed).to.equal(true);
        }
    });

    it("reports redirects without a second request", async () => {
        let responses = 0;
        const fixture = transportFixture({
            response: () => {
                responses++;
                return { status: 302 };
            },
        });
        expect(await fixture.send(post("mcp-events", () => prepared()))).to.deep.equal({
            kind: "rejected",
            reason: "redirect",
            status: 302,
            writeInitiated: true,
        });
        expect(responses).to.equal(1);
        expect(fixture.request?.ended).to.equal(true);
    });

    it("rechecks final authorization immediately before the first write", async () => {
        const fixture = transportFixture();
        const outcome = await fixture.send(post("mcp-events", async () => ({
            body: Buffer.from("must-not-send"),
            headers: mcpHeaders,
            isCurrent: () => false,
        })));
        expect(outcome).to.deep.equal({ kind: "rejected", reason: "authorization", writeInitiated: false });
        expect(fixture.request?.ended).to.equal(false);
        expect(fixture.request?.destroyed).to.equal(true);
    });

    it("writes exact bytes with each bounded header profile", async () => {
        const profiles: Array<[HeaderProfile, Record<string, string>]> = [
            ["mcp-events", mcpHeaders],
            ["web-push", {
                "content-type": "application/octet-stream",
                "content-encoding": "aes128gcm",
                ttl: "60",
                urgency: "normal",
                authorization: "vapid t=token,k=key",
            }],
        ];
        for (const [profile, headers] of profiles) {
            const fixture = transportFixture();
            expect((await fixture.send(post(profile, () => prepared(headers)))).kind).to.equal("accepted");
            expect(fixture.request?.body?.toString()).to.equal("exact-body");
            expect(fixture.requestOptions?.headers).to.include({
                ...headers,
                host: "events.example.com",
                "content-length": "10",
            });
        }
    });

    it("runs signed callback verification through the bounded transport response", async () => {
        const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
        const matching = transportFixture({
            response: (body) => ({
                status: 200,
                body: Buffer.from(JSON.stringify({ challenge: JSON.parse(body.toString()).challenge, extra: true })),
            }),
        });
        const verify = createMcpCallbackVerifier(matching.send);
        const input = {
            url: "https://events.example.com/callback",
            subscriptionId: "sub_1",
            secret,
            authorizationDeadlineMs: Date.now() + 1_000,
            canStart: () => true,
            revalidate: async () => ({ isCurrent: () => true }),
        };
        expect(await verify(input)).to.deep.equal({ kind: "verified" });

        const oversized = transportFixture({ response: () => ({ status: 200, body: Buffer.alloc(64 * 1024 + 1) }) });
        expect((await createMcpCallbackVerifier(oversized.send)(input)).kind).to.equal("unknown");
        const malformed = transportFixture({ response: () => ({ status: 200, body: Buffer.from("{not-json") }) });
        expect(await createMcpCallbackVerifier(malformed.send)(input)).to.deep.equal({
            kind: "failed",
            reason: "challenge",
        });
    });
});
