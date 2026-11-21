import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const CLI_VERSION = "v1.97.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixtureSource = path.join(here, "fixtures", "dependabot-docker-selection");
const cli = process.env.DEPENDABOT_CLI ?? "dependabot";

const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
if (version !== `dependabot version ${CLI_VERSION}`) {
    throw new Error(`Dependabot CLI ${CLI_VERSION} is required; received ${JSON.stringify(version)}`);
}

const config = parse(fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8"));
const docker = config.updates.filter(update => update["package-ecosystem"] === "docker");
if (docker.length !== 1) throw new Error(`Expected one Docker update entry; received ${docker.length}`);
const configuredIgnore = docker[0].ignore ?? [];

// The CLI preserves an existing local Git repository. Commit the fixture once
// with fixed identity and timestamps so record and replay observe the same
// base SHA instead of creating a fresh, time-dependent commit in each updater.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dependabot-docker-fixture-"));
fs.cpSync(fixtureSource, fixture, { recursive: true });
execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: fixture });
execFileSync("git", ["config", "user.name", "Dependabot smoke fixture"], { cwd: fixture });
execFileSync("git", ["config", "user.email", "dependabot-smoke@example.invalid"], { cwd: fixture });
execFileSync("git", ["add", "."], { cwd: fixture });
execFileSync("git", ["commit", "--quiet", "-m", "Pinned Docker selection fixture"], {
    cwd: fixture,
    env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-11-21T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-21T00:00:00Z",
    },
});

const variants = [
    { name: "exact", ignore: configuredIgnore, wanted: ["node"], satisfiesWantedOutcome: true },
    { name: "missing", ignore: [], wanted: ["node", "playwright"], satisfiesWantedOutcome: false },
    { name: "broad", ignore: [{ "dependency-name": "*" }], wanted: [], satisfiesWantedOutcome: false },
];

function proposalNames(smoke) {
    return (smoke.output ?? [])
        .filter(output => output.type === "create_pull_request")
        .flatMap(output => output.expect.data.dependencies.map(dependency => dependency.name))
        .sort();
}

for (const variant of variants) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `dependabot-docker-${variant.name}-`));
    const inputPath = path.join(temp, "input.yml");
    const smokePath = path.join(temp, "smoke.yml");
    const cachePath = path.join(temp, "cache");
    const input = {
        job: {
            "package-manager": "docker",
            "allowed-updates": [{ "update-type": "all" }],
            "ignore-conditions": variant.ignore,
            source: { provider: "github", repo: "synthetic/dependabot-docker-selection", directory: "/" },
        },
    };
    fs.writeFileSync(inputPath, stringify(input));

    // First record the updater's proposal intents, then replay the generated
    // smoke test through the official assertion interface. Neither command
    // calls GitHub's pull-request creation API.
    execFileSync(cli, ["update", "-f", inputPath, "--local", fixture, "-o", smokePath, "--timeout", "10m"], {
        stdio: "inherit",
    });
    const recorded = parse(fs.readFileSync(smokePath, "utf8"));
    const names = proposalNames(recorded);
    if (JSON.stringify(names) !== JSON.stringify(variant.wanted)) {
        throw new Error(`${variant.name}: expected ${variant.wanted}, received ${names}`);
    }
    // `update -o` adds upper-bound ignore conditions to freeze discovered
    // versions. Docker's v-prefixed compound Playwright tag is not a valid
    // RubyGems requirement (for example, `>v1.65.1-jammy`), so restore the
    // variant's real selection input before replaying the recorded intents.
    recorded.input.job["ignore-conditions"] = variant.ignore;
    fs.writeFileSync(smokePath, stringify(recorded));
    execFileSync(cli, ["test", "-f", smokePath, "--local", fixture, "--cache", cachePath], {
        stdio: "inherit",
    });

    const satisfiesWantedOutcome = JSON.stringify(names) === JSON.stringify(["node"]);
    console.log(
        `${variant.name}: proposal intents=${
            JSON.stringify(names)
        }; satisfies wanted outcome=${satisfiesWantedOutcome}`,
    );
    if (satisfiesWantedOutcome !== variant.satisfiesWantedOutcome) {
        throw new Error(`${variant.name}: false-success classification was ${satisfiesWantedOutcome}`);
    }
}

console.log("Dependabot Docker selection smoke tests passed; this does not verify hosted PR submission.");
