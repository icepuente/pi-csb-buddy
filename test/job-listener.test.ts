/**
 * The buddy next to the real pi-job-listener (the version pinned in devDependencies), running real
 * background processes. Load order matches a typical install: pi-job-listener first, so its wakes
 * go out before the buddy's own settle handler runs.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createHost, sleep, tempDir, waitFor } from "./host.ts";
import csbBuddy from "../src/index.ts";

let jobListener: (pi: any) => void;
let host: ReturnType<typeof createHost>;
const started: string[] = [];

before(async () => {
  // Read once at import: keep pi-job-listener away from the real job history and the local model.
  process.env.PI_JOB_LISTENER_JOBS_DIR = tempDir("jobs");
  process.env.PI_JOB_LISTENER_GRACE_MS = "300";
  process.env.PI_JOB_LISTENER_GATE = "off";
  ({ default: jobListener } = await import("pi-job-listener/src/extension.ts"));
});

async function session() {
  // pi-job-listener names its session directory by the second; never share one between tests.
  await sleep(1_100);
  const buddyDir = tempDir("state");
  process.env.CSB_PI_BUDDY_DIR = buddyDir;
  host = createHost([jobListener, csbBuddy], buddyDir);
  await host.start();
}

/** One agent run whose tool call is a supervised bash command. */
async function bash(command: string, options: { stall_seconds?: number; thinkMs?: number } = {}) {
  const { thinkMs, ...params } = options;
  const result = await host.run({ tool: { name: "bash", args: { command, ...params } }, thinkMs });
  if (result.details?.job_id) started.push(result.details.job_id);
  return result;
}

afterEach(async () => {
  for (const id of started.splice(0)) {
    await host.run({ tool: { name: "jobs", args: { action: "kill", job_id: id } } });
  }
  await host.idle();
  await host.stop();
});

after(() => {
  // Wakes for jobs killed during cleanup are not this suite's concern.
  setTimeout(() => process.exit(0), 100).unref();
});

test("a command that finishes inside the grace window settles on waiting", async () => {
  await session();
  const result = await bash("echo hi");
  assert.equal(result.details.detached, undefined);
  assert.equal(host.state(), "waiting");
});

test("a background job keeps the buddy active until its exit has been handled", async () => {
  await session();
  const result = await bash("sleep 2; echo built", { stall_seconds: 30 });
  assert.equal(result.details.detached, true);
  assert.equal(host.state(), "active");
  await waitFor(() => host.wakes.length === 1, host.record);
  await host.idle();
  assert.equal(host.state(), "waiting");
  const firstDone = host.states.indexOf("waiting");
  assert.ok(firstDone === host.states.length - 1, `done shown early: ${host.states.join(" → ")}`);
});

test("a job that exits while the run is still going does not flash done", async () => {
  await session();
  // The job ends while the model is still "thinking", so pi-job-listener sends its wake from
  // agent_settled and pi defers that run until every settle handler is done.
  await bash("sleep 1; echo built", { stall_seconds: 30, thinkMs: 2_500 });
  assert.equal(host.wakes.length, 1);
  await host.idle();
  assert.equal(host.state(), "waiting");
  // Settling held on active, the deferred run took over, and only its end showed done.
  assert.deepEqual(host.states.slice(-3), ["active", "thinking", "waiting"], host.states.join(" → "));
  assert.equal(host.states.filter((state) => state === "waiting").length, 1, host.states.join(" → "));
});

test("a dev server is parked after its quiet wake and keeps serving", async () => {
  await session();
  await bash(`node -e "console.log('listening on 5173'); setInterval(() => {}, 1e9)"`, { stall_seconds: 1 });
  assert.equal(host.state(), "active");
  await waitFor(() => host.wakes.length === 1, host.record);
  assert.match(host.wakes[0], /still running/);
  await host.idle();
  assert.equal(host.state(), "waiting");
  // Through a heartbeat and past another stall threshold: no new wake, still done.
  await sleep(6_000);
  host.record();
  assert.equal(host.wakes.length, 1);
  assert.equal(host.state(), "waiting");
});
