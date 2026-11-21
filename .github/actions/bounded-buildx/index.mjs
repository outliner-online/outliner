import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const deadlineText = process.env.DIRECT_RUNNER_OS_PROVISIONING_DEADLINE_NS;
if (!/^\d+$/.test(deadlineText ?? "")) {
    throw new Error("DIRECT_RUNNER_OS_PROVISIONING_DEADLINE_NS must be a monotonic nanosecond deadline");
}

const input = (name) => process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`] ?? "";
const deadline = BigInt(deadlineText);
const graceMs = Number.parseInt(input("cleanup-grace-seconds"), 10) * 1_000;
if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("cleanup-grace-seconds must be non-negative");

const args = ["buildx", "build", "--tag", input("tags"), "--progress", "plain"];
if (input("file")) args.push("--file", input("file"));
if (input("load") === "true") args.push("--load");
if (input("cache-from")) args.push("--cache-from", input("cache-from"));
if (input("cache-to")) args.push("--cache-to", input("cache-to"));
args.push(input("context"));

const evidencePath = input("evidence-file");
const startedNs = process.hrtime.bigint();
const remainingNs = deadline - startedNs;
if (remainingNs <= 0n) {
    await record({ outcome: "deadline", startedNs, endedNs: process.hrtime.bigint(), buildStarted: false });
    throw new Error("Fixture provisioning deadline exceeded before the owned build started");
}

const child = spawn("docker", args, { detached: true, stdio: "inherit" });
let expired = false;
let nativeError;
child.once("error", (error) => nativeError = error);
const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
let expireBuild;
const deadlineReached = new Promise((resolve) => expireBuild = resolve);
const deadlineTimer = setTimeout(() => {
    expired = true;
    signalGroup("SIGTERM");
    expireBuild(undefined);
}, Number((remainingNs + 999_999n) / 1_000_000n));

const result = await Promise.race([closed, deadlineReached]);
clearTimeout(deadlineTimer);

if (expired || result === undefined) {
    expired = true;
    signalGroup("SIGTERM");
    await Promise.race([closed, delay(graceMs)]);
    if (groupAlive()) {
        signalGroup("SIGKILL");
        await waitForGroupExit(graceMs);
    }
    const endedNs = process.hrtime.bigint();
    const terminated = !groupAlive();
    await record({ outcome: "deadline", startedNs, endedNs, buildStarted: true, terminated });
    if (!terminated) throw new Error("Owned fixture build did not stop within its cleanup allowance");
    throw new Error("Fixture provisioning deadline exceeded; the owned build was terminated");
}

const endedNs = process.hrtime.bigint();
if (nativeError || result.code !== 0) {
    await record({
        outcome: "failure",
        startedNs,
        endedNs,
        buildStarted: true,
        exitCode: result.code,
        signal: result.signal,
    });
    throw nativeError ?? new Error(`Fixture build failed with exit code ${result.code ?? `signal ${result.signal}`}`);
}
await record({ outcome: "success", startedNs, endedNs, buildStarted: true, exitCode: 0 });

function signalGroup(signal) {
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
    }
}

function groupAlive() {
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
}

async function waitForGroupExit(limitMs) {
    const until = Date.now() + limitMs;
    while (groupAlive() && Date.now() < until) await delay(25);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function record(value) {
    if (!evidencePath) return;
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const serializable = Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, typeof item === "bigint" ? item.toString() : item]),
    );
    await writeFile(evidencePath, `${JSON.stringify(serializable)}\n`);
}
