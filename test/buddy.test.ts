/** The buddy on its own, against a hand-written pi-job-listener event log. */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createHost, sleep, tempDir } from "./host.ts";
import csbBuddy from "../src/index.ts";

let host: ReturnType<typeof createHost>;
let jobsDir: string;
let events: string;

const log = (id: string) => join(jobsDir, `${id}.log`);
const event = (fields: Record<string, unknown>, at = new Date()) =>
  appendFileSync(events, `${JSON.stringify({ ts: at.toISOString(), ...fields })}\n`);

/** Report a bash call that returned a background job, as pi-job-listener does. */
async function startJob(id: string) {
  writeFileSync(log(id), "started\n");
  const past = new Date(Date.now() - 60_000);
  utimesSync(log(id), past, past);
  await host.run({ tool: { name: "fake-bash", args: { id } } });
}

beforeEach(async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const buddyDir = tempDir("state");
  jobsDir = tempDir("jobs");
  events = join(jobsDir, "events.jsonl");
  writeFileSync(events, "");
  process.env.CSB_PI_BUDDY_DIR = buddyDir;
  host = createHost([csbBuddy, (pi) => pi.registerTool({
    name: "fake-bash",
    execute: async (_id: string, args: { id: string }) => args.id === "inline"
      ? { content: [], details: { exit_code: 0 } }
      : { content: [], details: { job_id: args.id, log_path: log(args.id), detached: true } },
  })], buddyDir);
  await host.start();
});

afterEach(async () => {
  await host.stop();
  mock.timers.reset();
});

test("a run with no background job settles on waiting", async () => {
  await host.run({ tool: { name: "fake-bash", args: { id: "inline" } } });
  assert.equal(host.state(), "waiting");
});

test("a job that has not exited or gone quiet keeps the buddy active", async () => {
  await startJob("job-1");
  assert.equal(host.state(), "active");
  assert.ok(!host.states.includes("waiting"));
});

test("a quiet job is parked once a turn has handled its wake", async () => {
  await startJob("job-1");
  event({ event: "stalled", job: "job-1" });
  await host.run();
  assert.equal(host.state(), "active", "stall report not delivered yet");
  await sleep(5);
  event({ event: "wake", jobs: ["job-1"] });
  await sleep(5);
  await host.run();
  assert.equal(host.state(), "waiting", "dev server parked");
});

test("a wake sent while the run settles is not yet handled", async () => {
  await startJob("job-1");
  await sleep(5);
  event({ event: "terminal", job: "job-1", reason: "exited" });
  event({ event: "wake", jobs: ["job-1"] });
  await host.emit("agent_settled", { aborted: false });
  mock.timers.tick(5_000);
  assert.equal(host.state(), "active");
});

test("a wake logged after the turn started is unhandled even when its clock says otherwise", async () => {
  // The final turn start and the settle wake can share a millisecond; only log order separates them.
  await startJob("job-1");
  await host.emit("turn_start");
  const sameMoment = new Date(Date.now() - 1_000);
  event({ event: "terminal", job: "job-1", reason: "exited" }, sameMoment);
  event({ event: "wake", jobs: ["job-1"] }, sameMoment);
  await host.emit("agent_settled", { aborted: false });
  assert.equal(host.state(), "active");
  await host.emit("turn_start");
  await host.emit("agent_settled", { aborted: false });
  assert.equal(host.state(), "waiting", "handled by the turn that followed");
});

test("a parked job that prints again counts until its next wake", async () => {
  await startJob("job-1");
  event({ event: "stalled", job: "job-1" }, new Date(Date.now() - 30_000));
  event({ event: "wake", jobs: ["job-1"] }, new Date(Date.now() - 30_000));
  await host.run();
  assert.equal(host.state(), "waiting");
  appendFileSync(log("job-1"), "GET /\n");
  mock.timers.tick(5_000);
  assert.equal(host.state(), "active");
});

test("an exited job that was woken is dropped on the next heartbeat", async () => {
  await startJob("job-1");
  event({ event: "terminal", job: "job-1", reason: "exited" });
  mock.timers.tick(5_000);
  assert.equal(host.state(), "active");
  event({ event: "wake", jobs: ["job-1"] });
  await sleep(5);
  await host.emit("turn_start");
  await host.emit("agent_settled", { aborted: false });
  assert.equal(host.state(), "waiting");
});

test("a question still shows awaiting_approval while a job runs", async () => {
  await startJob("job-1");
  await host.run({ reply: "Should I go ahead?" });
  assert.equal(host.state(), "awaiting_approval");
});

test("only stall, exit and wake lines are parsed", async () => {
  await startJob("job-1");
  appendFileSync(events, '{"ts":"x","event":"gate","job":"job-1","tail":"{not json\n');
  appendFileSync(events, "torn line\n");
  event({ event: "stalled", job: "job-1" }, new Date(Date.now() - 30_000));
  event({ event: "wake", jobs: ["job-1"] }, new Date(Date.now() - 30_000));
  await host.run();
  assert.equal(host.state(), "waiting");
});

test("a job whose event log cannot be read is ignored", async () => {
  // The job's directory has no events.jsonl.
  mkdirSync(join(jobsDir, "elsewhere"));
  await host.run({ tool: { name: "fake-bash", args: { id: join("elsewhere", "job-9") } } });
  assert.equal(host.state(), "waiting");
});
