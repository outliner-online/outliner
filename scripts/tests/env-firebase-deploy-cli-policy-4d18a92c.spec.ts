import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const expected = readFileSync(resolve(root, ".firebase-tools-version"), "utf8").trim();

describe("Firebase production deploy CLI policy", () => {
    test.each([0, 7])("workflow leaves legacy config untouched and preserves deploy exit %s", status => {
        const fixture = mkdtempSync(resolve(tmpdir(), "firebase-workflow-policy-"));
        const bin = resolve(fixture, "bin");
        mkdirSync(bin);
        mkdirSync(resolve(fixture, "scripts"));
        const log = resolve(fixture, "calls.log");
        const cli = resolve(fixture, "scripts/firebase-cli.sh");
        writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$*" >> "$INVOCATION_LOG"
case "$1" in
  --version) echo '${expected}';;
  deploy) echo 'controlled deploy outcome'; exit "$DEPLOY_EXIT";;
  functions:config:*) echo 'legacy command disabled' >&2; exit 1;;
  *) exit 2;;
esac
`);
        chmodSync(cli, 0o755);
        writeFileSync(resolve(bin, "sleep"), "#!/bin/sh\nexit 0\n");
        chmodSync(resolve(bin, "sleep"), 0o755);
        const workflow = parse(readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8"));
        const commands = workflow.jobs.deploy.steps
            .filter((step: { run?: string; }) => step.run?.includes("scripts/firebase-cli.sh"))
            .map((step: { run: string; }) => step.run);
        let lastStatus = 0;
        for (const command of commands) {
            const result = spawnSync("bash", ["-euo", "pipefail", "-c", command], {
                cwd: fixture,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH}`,
                    INVOCATION_LOG: log,
                    DEPLOY_EXIT: String(status),
                },
            });
            lastStatus = result.status ?? -1;
            if (lastStatus !== 0) break;
        }
        const calls = readFileSync(log, "utf8").trim().split("\n");
        expect(calls.some(call => call.startsWith("functions:config:"))).toBe(false);
        expect(calls.filter(call => call.startsWith("deploy "))).toEqual(
            Array(status === 0 ? 1 : 3).fill(
                "deploy --only hosting,functions,firestore:rules,storage --project outliner-d57b0 --non-interactive --force",
            ),
        );
        expect(lastStatus).toBe(status);
    });

    test("a clean deploy installs the declared CLI and deploys through the version-checking wrapper", () => {
        const fixture = mkdtempSync(resolve(tmpdir(), "firebase-deploy-policy-"));
        const bin = resolve(fixture, "bin");
        const invocationLog = resolve(fixture, "invocations.log");
        mkdirSync(bin);
        mkdirSync(resolve(fixture, "client"));
        mkdirSync(resolve(fixture, "functions"));
        mkdirSync(resolve(fixture, "scripts"));

        cpSync(resolve(root, "deploy-to-firebase.sh"), resolve(fixture, "deploy-to-firebase.sh"));
        cpSync(resolve(root, "scripts/firebase-cli.sh"), resolve(fixture, "scripts/firebase-cli.sh"));
        cpSync(resolve(root, ".firebase-tools-version"), resolve(fixture, ".firebase-tools-version"));
        writeFileSync(resolve(fixture, "client/.env.firebase"), "TEST_ONLY=1\n");

        const npm = resolve(bin, "npm");
        writeFileSync(
            npm,
            `#!/bin/sh
set -eu
printf 'npm:%s\\n' "$*" >> "$INVOCATION_LOG"
if [ "$*" = 'install --global firebase-tools@${expected}' ]; then
  cat > "$FIREBASE_TEST_BIN/firebase" <<'EOF'
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "${expected}"
else
  printf 'firebase:%s\\n' "$*" >> "$INVOCATION_LOG"
fi
EOF
  chmod +x "$FIREBASE_TEST_BIN/firebase"
fi
`,
        );
        chmodSync(npm, 0o755);

        const result = spawnSync("bash", ["deploy-to-firebase.sh"], {
            cwd: fixture,
            encoding: "utf8",
            env: {
                ...process.env,
                FIREBASE_TEST_BIN: bin,
                INVOCATION_LOG: invocationLog,
                PATH: `${bin}:${process.env.PATH}`,
            },
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain(`Firebase CLI version: ${expected}`);
        expect(readFileSync(invocationLog, "utf8")).toContain(
            `npm:install --global firebase-tools@${expected}`,
        );
        expect(readFileSync(invocationLog, "utf8")).toContain("firebase:deploy");

        const deployScript = readFileSync(resolve(root, "deploy-to-firebase.sh"), "utf8");
        expect(deployScript).not.toContain("firebase.tools");
        expect(deployScript).toContain('npm install --global "firebase-tools@${FIREBASE_TOOLS_VERSION}"');
        expect(deployScript).toContain("scripts/firebase-cli.sh deploy");
    });
});
