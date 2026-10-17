/**
 * End to end: real pi (the pinned devDependency) in RPC mode with the buddy, the real
 * pi-job-listener, a scripted `claude-bridge` model (no model calls), and a recorder that reads the
 * buddy's state after every handler. Agent dir, job history and buddy dir are all throwaway.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { sleep, tempDir } from "./host.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensions = [
  join(root, "test", "e2e", "scripted-provider.ts"),
  join(root, "node_modules", "pi-job-listener", "src", "extension.ts"),
  join(root, "src", "index.ts"),
  join(root, "test", "e2e", "recorder.ts"),
];

interface Record { event: string; state?: string; at: number }
const buddyDir = tempDir("e2e-state");
const jobsDir = tempDir("e2e-jobs");
const recordFile = join(tempDir("e2e-record"), "record.jsonl");
let pi: ChildProcess;
let stderr = "";
let settles = 0;

const records = (): Record[] => existsSync(recordFile)
  ? readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
const buddyState = () => JSON.parse(readFileSync(join(buddyDir, `${pi.pid}.json`), "utf8")).state;

async function until(check: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}\n${stderr.slice(-2_000)}`);
    await sleep(25);
  }
}

/** Send a prompt and wait for `runs` settled runs (the prompt's own, plus any wakes it causes). */
async function scene(message: string, runs: number): Promise<Record[]> {
  const from = records().length;
  const target = settles + runs;
  pi.stdin!.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  await until(() => settles >= target, `${message}: ${runs} settled run(s)`);
  await sleep(200); // anything that would follow the last settle shows up here
  assert.equal(settles, target, `${message}: an unexpected extra run`);
  return records().slice(from);
}

const settledStates = (steps: Record[]) => steps.filter((step) => step.event === "agent_settled").map((step) => step.state);
const doneShown = (steps: Record[]) => steps.filter((step) => step.state === "waiting").length;

before(async () => {
  const args = ["--mode", "rpc", "--no-extensions", ...extensions.flatMap((path) => ["-e", path]),
    "--model", "claude-bridge/scripted", "--no-session", "--offline", "--no-mcp", "--no-approve", "-nc", "-ns", "-np"];
  pi = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: tempDir("e2e-agent"),
      PI_JOB_LISTENER_JOBS_DIR: jobsDir,
      PI_JOB_LISTENER_GRACE_MS: "300",
      PI_JOB_LISTENER_GATE: "off",
      CSB_PI_BUDDY_DIR: buddyDir,
      CSB_E2E_RECORD: recordFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  pi.stderr!.on("data", (chunk) => { stderr += chunk; });
  let buffer = "";
  pi.stdout!.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      try { if (JSON.parse(line).type === "agent_settled") settles++; } catch { /* not a record */ }
    }
  });
  await until(() => existsSync(join(buddyDir, `${pi.pid}.json`)), "buddy state file", 30_000);
});

after(() => {
  pi?.kill();
  // Background jobs outlive pi on purpose; never leave one running after the suite.
  try {
    for (const line of readFileSync(join(jobsDir, "registry.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const { pid } = JSON.parse(line);
      if (pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    }
  } catch { /* no jobs started */ }
});

test("pi: a quick command settles on waiting", async () => {
  const steps = await scene("quick", 1);
  assert.ok(steps.some((step) => step.event === "tool_execution_end"), "the scripted model called no tool");
  assert.deepEqual(settledStates(steps), ["waiting"]);
});

test("pi: a background build holds active until its exit is handled", async () => {
  const steps = await scene("build", 2);
  assert.deepEqual(settledStates(steps), ["active", "waiting"]);
  assert.equal(doneShown(steps), 1, JSON.stringify(steps));
});

test("pi: a job that ends mid-run does not flash done before its deferred wake", async () => {
  const steps = await scene("slowbuild", 2);
  assert.deepEqual(settledStates(steps), ["active", "waiting"]);
  assert.equal(doneShown(steps), 1, JSON.stringify(steps));
});

test("pi: a dev server is parked after its quiet wake", async () => {
  const steps = await scene("server", 2);
  assert.deepEqual(settledStates(steps), ["active", "waiting"]);
  await sleep(6_500); // past a heartbeat and the stall threshold
  assert.equal(buddyState(), "waiting");
});

test("pi: stopping the server ends on waiting", async () => {
  const steps = await scene("stop", 2);
  assert.equal(settledStates(steps).at(-1), "waiting");
});
