/** Report presence and activity of Pi claude-bridge sessions to the buddy. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HEARTBEAT_MS = 5_000;
type Activity = "idle" | "thinking" | "active" | "awaiting_approval" | "waiting" | "error" | "limit";

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
  let failure: "error" | "limit" | undefined;
  let outcome: "completed" | "aborted" | "error" | undefined;

  function resetActivity() {
    running = compacting = false;
    prompts = 0;
    tools.clear();
    failure = outcome = undefined;
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
    // Inspect only provider error metadata, never assistant text or tool output.
    failure = /\b429\b|rate[_ -]?limit|usage limit|(?:reached|hit) your .{0,24}limit|out of extra usage/i
      .test(errorMessage || "") ? "limit" : "error";
    setBase(failure);
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
    timer = setInterval(publish, HEARTBEAT_MS);
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
    if (sessionActive && event.message.role === "assistant" && event.message.stopReason === "error") {
      recordFailure(event.message.errorMessage);
    }
  });
  pi.on("tool_execution_start", (event) => {
    if (!sessionActive) return;
    tools.add(event.toolCallId);
    refreshActivity();
  });
  pi.on("tool_execution_end", (event) => {
    if (!sessionActive) return;
    tools.delete(event.toolCallId);
    setBase(event.isError ? "error" : "thinking");
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
    setBase(event.aborted ? "waiting" : outcome === "error" ? (failure || "error") : "waiting");
  });
}
