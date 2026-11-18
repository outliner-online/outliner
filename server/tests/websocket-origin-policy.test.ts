import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect } from "chai";
import sinon from "sinon";
import WebSocket from "ws";
import * as Y from "yjs";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

const productionOrigin = "https://outliner-online.com";
const externalClientIp = "203.0.113.42";

class ProductionOriginWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols, {
            headers: {
                Origin: productionOrigin,
                "X-Forwarded-For": externalClientIp,
            },
        });
    }
}

const waitForClose = (socket: WebSocket) =>
    new Promise<{ code: number; reason: string; }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket rejection")), 8_000);
        socket.once("close", (code, reason) => {
            clearTimeout(timeout);
            resolve({ code, reason: reason.toString() });
        });
        socket.once("error", error => {
            clearTimeout(timeout);
            reject(error);
        });
    });

describe("production WebSocket Origin policy", () => {
    let port: number;
    let shutdown: () => Promise<void>;
    let checkAccessStub: sinon.SinonStub;
    let verifyTokenStub: sinon.SinonStub;
    const providers: HocuspocusProvider[] = [];

    beforeEach(async () => {
        process.env.DISABLE_PERSISTENCE = "true";
        process.env.ALLOW_TEST_ACCESS = "false";
        checkAccessStub = sinon.stub().resolves(false);
        verifyTokenStub = sinon.stub().rejects(new Error("invalid token (test stub)"));

        const config = loadConfig({
            PORT: "0",
            LOG_LEVEL: "silent",
            ORIGIN_ALLOWLIST: productionOrigin,
            TRUST_PROXY_HEADERS: "true",
            TRUSTED_PROXY_HOPS: "1",
        });
        const result = await startServer(config, undefined, {
            checkContainerAccess: checkAccessStub,
            verifyIdTokenCached: verifyTokenStub,
        });
        shutdown = result.shutdown;
        await new Promise<void>(resolve => {
            if (result.server.listening) resolve();
            else result.server.once("listening", resolve);
        });
        port = (result.server.address() as { port: number; }).port;
    });

    afterEach(async () => {
        for (const provider of providers.splice(0)) provider.destroy();
        await shutdown?.();
        sinon.restore();
        delete process.env.DISABLE_PERSISTENCE;
        delete process.env.ALLOW_TEST_ACCESS;
    });

    it("synchronizes the demo room from the allowed production Origin and a non-loopback IP", async () => {
        const createProvider = (document: Y.Doc) => {
            const provider = new HocuspocusProvider({
                url: `ws://127.0.0.1:${port}/projects/demo`,
                name: "projects/demo",
                document,
                token: "1",
                WebSocketPolyfill: ProductionOriginWebSocket,
            });
            providers.push(provider);
            return provider;
        };
        const source = new Y.Doc();
        const replica = new Y.Doc();
        const sourceProvider = createProvider(source);
        const replicaProvider = createProvider(replica);

        await Promise.all([
            new Promise<void>(resolve => sourceProvider.on("synced", () => resolve())),
            new Promise<void>(resolve => replicaProvider.on("synced", () => resolve())),
        ]);
        const synchronized = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timed out waiting for Yjs synchronization")), 8_000);
            replica.on("update", () => {
                if (replica.getMap("origin-policy").get("status") === "synchronized") {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
        source.getMap("origin-policy").set("status", "synchronized");
        await synchronized;

        expect(replica.getMap("origin-policy").get("status")).to.equal("synchronized");
        expect(verifyTokenStub.called).to.equal(false);
        expect(checkAccessStub.called).to.equal(false);
    });

    for (
        const [label, origin] of [
            ["an unlisted Origin", "https://untrusted.example"],
            ["a missing Origin", undefined],
        ] as const
    ) {
        it(`rejects ${label} from a non-loopback IP`, async () => {
            const headers: Record<string, string> = { "X-Forwarded-For": externalClientIp };
            if (origin) headers.Origin = origin;
            const socket = new WebSocket(`ws://127.0.0.1:${port}/projects/demo`, { headers });

            expect(await waitForClose(socket)).to.deep.equal({
                code: 4003,
                reason: "ORIGIN_NOT_ALLOWED",
            });
            expect(verifyTokenStub.called).to.equal(false);
            expect(checkAccessStub.called).to.equal(false);
        });
    }

    it("continues into the protected-room authentication gate after allowing the Origin", async () => {
        const document = new Y.Doc();
        const provider = new HocuspocusProvider({
            url: `ws://127.0.0.1:${port}/projects/protected`,
            name: "projects/protected",
            document,
            token: "invalid-token",
            WebSocketPolyfill: ProductionOriginWebSocket,
        });
        providers.push(provider);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timed out waiting for authentication rejection")),
                8_000);
            provider.on("authenticated", () => {
                clearTimeout(timeout);
                reject(new Error("Invalid token authenticated after passing the Origin check"));
            });
            provider.on("authenticationFailed", () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        // This isolated server deliberately has no Firebase app. Reaching the existing
        // FIREBASE_NOT_READY rejection proves that Origin admission did not grant access.
        expect(verifyTokenStub.called).to.equal(false);
        expect(checkAccessStub.called).to.equal(false);
    });
});
