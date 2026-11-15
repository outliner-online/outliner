import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const verifier = resolve(process.cwd(), "scripts/verify-production-build.mjs");

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("production build Firebase origin verifier", () => {
    it("rejects a wrong emitted resolver even when the bundle retains the expected configuration string", () => {
        const fixture = mkdtempSync(join(tmpdir(), "outliner-production-verifier-"));
        temporaryDirectories.push(fixture);
        const buildDirectory = join(fixture, "build");
        mkdirSync(buildDirectory);
        writeFileSync(
            join(buildDirectory, "app.js"),
            'const env = { VITE_FIREBASE_FUNCTIONS_URL: "https://outliner-online.com" };',
        );
        const resolverModule = join(fixture, "firebaseFunctionsUrl.mjs");
        writeFileSync(
            resolverModule,
            "export function resolver(name) { return `http://localhost:57070/api/${name}`; }",
        );

        expect(() =>
            execFileSync(
                process.execPath,
                [verifier, "--build-dir", buildDirectory, "--resolver-module", resolverModule],
                { encoding: "utf8", stdio: "pipe" },
            )
        ).toThrow(/Emitted Firebase resolver returned http:\/\/localhost:57070\/api\/getUserProjects/u);
    });
});
