/** Report presence and activity of Pi claude-bridge sessions to the buddy. */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HEARTBEAT_MS = 5_000;
// A reply that asks the user to decide: a "Decision(s)" heading or line, or a closing question.
const DECISION_MARKER = /^[\s#>*_-]*decisions?\b/im;
const CLOSING_QUESTION = /\?[\s*_`'")\]]*$/;
type Activity = "idle" | "thinking" | "active" | "awaiting_approval" | "waiting" | "error" | "limit";
// Only these pi-job-listener events matter; other lines (gate samples carry output) are never parsed.
const JOB_EVENT = /^\{"ts":"[^"]*","event":"(?:stalled|terminal|wake)"/;

/** A pi-job-listener background job, known from the structured details of its bash result. */
interface BackgroundJob { id: string; log: string; events: string }
/** What a job's event log says: its last stall or exit report, and when a wake followed it. */
interface JobReport { at: number; ended: boolean; wokenAt?: number }

export default function csbBuddy(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  const directory = process.env.CSB_PI_BUDDY_DIR || join(homedir(), ".claude", "csb_pi_sessions");
  const file = join(directory, `${process.pid}.json`);
  const temporary = `${file}.tmp`;
  let sessionActive = false;
  let bridgeSelected = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activity: Activity = "idle";
  let activityAt = Date.now() / 1000;
  let baseActivity: Activity = "idle";
  let running = false;
  let compacting = false;
  let prompts = 0;
  const tools = new Set<string>();
  let toolFailed = false;
  let failure: "error" | "limit" | undefined;
  let outcome: "completed" | "aborted" | "error" | undefined;
  let asksUser = false;
  // What the last run settled on, before background jobs are considered.
  let settled: Activity | undefined;
  let turnAt = 0;
  const backgroundJobs = new Map<string, BackgroundJob>();
  const eventLogs = new Map<string, { stamp: string; reports: Map<string, JobReport> }>();

  function resetActivity() {
    running = compacting = false;
    prompts = 0;
    tools.clear();
    toolFailed = false;
    failure = outcome = undefined;
    asksUser = false;
    settled = undefined;
    backgroundJobs.clear();
    eventLogs.clear();
    activity = baseActivity = "idle";
    activityAt = Date.now() / 1000;
  }

  function refreshActivity() {
    if (!sessionActive) return;
    const next: Activity = prompts ? "awaiting_approval"
      : tools.size ? "active" : compacting ? "thinking" : baseActivity;
    if (next === activity) return;
    activity = next;
    activityAt = Date.now() / 1000;
    publish();
  }

  function setBase(next: Activity) {
    baseActivity = next;
    refreshActivity();
  }

  function recordFailure(errorMessage: string | undefined) {
    // Inspect only provider error metadata, never tool output.
    failure = /\b429\b|rate[_ -]?limit|usage limit|(?:reached|hit) your .{0,24}limit|out of extra usage/i
      .test(errorMessage || "") ? "limit" : "error";
    setBase(failure);
  }

  function readReports(events: string): Map<string, JobReport> {
    const stat = statSync(events);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = eventLogs.get(events);
    if (cached?.stamp === stamp) return cached.reports;
    const reports = new Map<string, JobReport>();
    for (const line of readFileSync(events, "utf8").split("\n")) {
      if (!JOB_EVENT.test(line)) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.event === "wake") {
          for (const id of Array.isArray(entry.jobs) ? entry.jobs : []) {
            const report = reports.get(id);
            if (report) report.wokenAt ??= Date.parse(entry.ts);
          }
        } else if (typeof entry.job === "string") {
          reports.set(entry.job, { at: Date.parse(entry.ts), ended: entry.event === "terminal" });
        }
      } catch { /* a torn line is not worth failing over */ }
    }
    eventLogs.set(events, { stamp, reports });
    return reports;
  }

  /**
   * Will pi-job-listener wake the agent again without a new prompt? A job that has not yet exited
   * or gone quiet will be reported, and so will one whose report no turn has handled yet: a wake sent
   * while the run settles starts its turn only after every settle handler. One that went quiet and was
   * handled is parked (a dev server) until it prints again or exits.
   */
  function jobsPending(): boolean {
    let pending = false;
    for (const [key, job] of backgroundJobs) {
      try {
        const report = readReports(job.events).get(job.id);
        if (!report || report.wokenAt === undefined || report.wokenAt > turnAt) pending = true;
        else if (report.ended) backgroundJobs.delete(key);
        else if (statSync(job.log).mtimeMs > report.at) pending = true;
      } catch {
        backgroundJobs.delete(key); // no readable event log: nothing can be known about the job
      }
    }
    return pending;
  }

  function settle() {
    if (settled) setBase(settled === "waiting" && backgroundJobs.size && jobsPending() ? "active" : settled);
  }

  function remove() {
    // An optional desktop companion must never interrupt a Pi session.
    for (const path of [file, temporary]) {
      try { rmSync(path, { force: true }); } catch { /* unavailable directory */ }
    }
  }

  function stopHeartbeat() {
    bridgeSelected = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    remove();
  }

  function publish() {
    if (!sessionActive || !bridgeSelected) return;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify({
        version: 1,
        pid: process.pid,
        provider: "claude-bridge",
        updated_at: Date.now() / 1000,
        state: activity,
        activity_at: activityAt,
      }), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, file);
    } catch { /* retry on the next heartbeat; no session failure */ }
  }

  function selectProvider(provider: string | undefined) {
    stopHeartbeat();
    if (!sessionActive || provider !== "claude-bridge") return;
    bridgeSelected = true;
    publish();
    timer = setInterval(() => { settle(); publish(); }, HEARTBEAT_MS);
    timer.unref();
  }

  function shutdown() {
    sessionActive = false;
    stopHeartbeat();
    resetActivity();
    process.removeListener("exit", shutdown);
  }

  pi.on("session_start", (_event, ctx) => {
    shutdown();
    // Print-mode jobs and subagents should not keep a desktop pet present.
    sessionActive = ctx.mode === "tui" || ctx.mode === "rpc";
    if (!sessionActive) return;
    process.once("exit", shutdown);
    selectProvider(ctx.model?.provider);
  });
  pi.on("model_select", (event) => {
    if (sessionActive) selectProvider(event.model.provider);
  });
  pi.on("session_shutdown", shutdown);

  const beginRun = () => {
    if (!sessionActive) return;
    running = true;
    failure = outcome = undefined;
    asksUser = false;
    settled = undefined;
    turnAt = Date.now();
    setBase("thinking");
  };
  pi.on("before_agent_start", beginRun);
  pi.on("agent_start", beginRun);
  pi.on("turn_start", beginRun);

  pi.on("message_update", (event) => {
    if (!sessionActive) return;
    const stream = event.assistantMessageEvent;
    if (stream.type === "thinking_start" || stream.type === "thinking_delta") {
      setBase("thinking");
    } else if (["text_start", "text_delta", "toolcall_start", "toolcall_delta"].includes(stream.type)) {
      setBase("active");
    } else if (stream.type === "error" && stream.reason === "error") {
      recordFailure(stream.error.errorMessage);
    }
  });
  pi.on("message_end", (event) => {
    if (!sessionActive || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      recordFailure(event.message.errorMessage);
      return;
    }
    // Keep only a yes/no flag; assistant text is never stored or written out.
    const text = event.message.content
      .map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
    asksUser = DECISION_MARKER.test(text) || CLOSING_QUESTION.test(text);
  });
  pi.on("tool_execution_start", (event) => {
    if (!sessionActive) return;
    tools.add(event.toolCallId);
    refreshActivity();
  });
  pi.on("tool_execution_end", (event) => {
    if (!sessionActive) return;
    tools.delete(event.toolCallId);
    // pi-job-listener hands a long command back as a background job; only its structured details are read.
    const details = event.result?.details;
    if (details?.detached === true && typeof details.job_id === "string" && typeof details.log_path === "string") {
      backgroundJobs.set(details.log_path, {
        id: details.job_id,
        log: details.log_path,
        events: join(dirname(details.log_path), "events.jsonl"),
      });
    }
    // Parallel tools: hold a failure until the whole batch ends, or a later success hides it.
    toolFailed ||= event.isError;
    if (tools.size) return;
    setBase(toolFailed ? "error" : "thinking");
    toolFailed = false;
  });
  pi.on("ui_prompt_start", () => {
    if (!sessionActive) return;
    prompts++;
    refreshActivity();
  });
  pi.on("ui_prompt_end", () => {
    if (!sessionActive) return;
    prompts = Math.max(0, prompts - 1);
    refreshActivity();
  });
  pi.on("session_before_compact", () => {
    if (!sessionActive) return;
    compacting = true;
    refreshActivity();
  });
  pi.on("session_compact", () => {
    if (!sessionActive) return;
    compacting = false;
    setBase(running ? "thinking" : "waiting");
  });
  pi.on("session_compact_failed", (event) => {
    if (!sessionActive) return;
    compacting = false;
    setBase(event.aborted ? (running ? "thinking" : "waiting") : "error");
  });
  pi.on("agent_before_settle", (event) => {
    if (sessionActive) outcome = event.outcome;
  });
  // agent_end can precede retries/continuations. Only settled means finished.
  pi.on("agent_settled", (event) => {
    if (!sessionActive) return;
    running = compacting = false;
    prompts = 0;
    tools.clear();
    toolFailed = false;
    settled = event.aborted ? "waiting"
      : outcome === "error" ? (failure || "error")
      : asksUser ? "awaiting_approval" : "waiting";
    // A background job that will still wake the agent means it is not done yet.
    settle();
  });
}
