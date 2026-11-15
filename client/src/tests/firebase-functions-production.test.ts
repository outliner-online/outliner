import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFirebaseFunctionUrl } from "../lib/firebaseFunctionsUrl";

// Exercise the real resolver and getEnv; only the build-time environment changes.
afterEach(() => vi.unstubAllEnvs());

describe("#5932 production Firebase origin", () => {
    for (const file of [".env.production", ".env.firebase"]) {
        it(`uses the canonical Hosting origin from ${file} (REQ-001/002/003/004)`, () => {
            const values = Object.fromEntries(
                readFileSync(file, "utf8")
                    .split("\n")
                    .filter(line => line.startsWith("VITE_"))
                    .map(line => line.split("=")),
            );
            vi.stubEnv("MODE", "production");
            vi.stubEnv("DEV", false);
            vi.stubEnv("VITE_FIREBASE_FUNCTIONS_URL", values.VITE_FIREBASE_FUNCTIONS_URL);
            for (const name of ["getUserProjects", "saveProject", "deleteProject", "listSchedules", "health"]) {
                expect(getFirebaseFunctionUrl(name)).toBe(`https://outliner-online.com/api/${name}`);
            }
            expect(values.VITE_FIREBASE_PROJECT_ID).toBe("outliner-d57b0");
            expect(values.VITE_FIREBASE_AUTH_DOMAIN).toBe("outliner-d57b0.firebaseapp.com");
            expect(values.VITE_YJS_WS_URL).toBe("wss://outliner-yjs-ws.outliner-online.com");
            expect(values.VITE_API_BASE_URL).toBeUndefined();
            expect(values.VITE_API_SERVER_URL).toBeUndefined();
        });
    }

    it("retains the configured development Hosting emulator route (REQ-005)", () => {
        vi.stubEnv("MODE", "development");
        vi.stubEnv("DEV", true);
        vi.stubEnv("VITE_FIREBASE_FUNCTIONS_URL", "http://localhost:57000");
        expect(getFirebaseFunctionUrl("getUserProjects"))
            .toBe("http://localhost:57000/api/getUserProjects");
    });

    it("retains the existing test emulator destination (REQ-005)", () => {
        vi.stubEnv("MODE", "test");
        vi.stubEnv("VITE_FIREBASE_FUNCTIONS_URL", "http://127.0.0.1:57070");
        expect(getFirebaseFunctionUrl("getUserProjects"))
            .toBe("http://127.0.0.1:57070/outliner-d57b0/us-central1/getUserProjects");
    });
});
