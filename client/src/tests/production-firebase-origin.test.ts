import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFirebaseFunctionUrl } from "../lib/firebaseFunctionsUrl";

const clientRoot = process.cwd();

function readEnvironment(fileName: string): Map<string, string> {
    const environment = new Map<string, string>();
    for (const line of readFileSync(`${clientRoot}/${fileName}`, "utf8").split(/\r?\n/u)) {
        const match = /^([^#=]+)=(.*)$/u.exec(line);
        if (match) environment.set(match[1], match[2]);
    }
    return environment;
}

describe("production Firebase API origin", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    for (const fileName of [".env.production", ".env.firebase"]) {
        it(`uses the custom Hosting domain in ${fileName} without changing Firebase or Yjs authorities`, () => {
            const environment = readEnvironment(fileName);

            expect(environment.get("VITE_FIREBASE_FUNCTIONS_URL")).toBe("https://outliner-online.com");
            expect(environment.get("VITE_FIREBASE_PROJECT_ID")).toBe("outliner-d57b0");
            expect(environment.get("VITE_FIREBASE_AUTH_DOMAIN")).toBe("outliner-d57b0.firebaseapp.com");
            expect(environment.get("VITE_YJS_WS_URL")).toBe("wss://outliner-yjs-ws.outliner-online.com");
            vi.stubEnv("MODE", "production");
            vi.stubEnv("DEV", false);
            vi.stubEnv("VITE_FIREBASE_FUNCTIONS_URL", environment.get("VITE_FIREBASE_FUNCTIONS_URL")!);
            expect(getFirebaseFunctionUrl("getUserProjects")).toBe(
                "https://outliner-online.com/api/getUserProjects",
            );
        });
    }

    it("keeps automated tests on the Firebase emulator", () => {
        vi.stubEnv("MODE", "test");
        vi.stubEnv("VITE_FIREBASE_FUNCTIONS_URL", "https://outliner-online.com");
        expect(getFirebaseFunctionUrl("getUserProjects")).toBe(
            "http://127.0.0.1:57070/outliner-d57b0/us-central1/getUserProjects",
        );
    });
});
