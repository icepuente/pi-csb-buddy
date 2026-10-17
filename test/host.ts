/** A fake pi host: just enough of pi's extension runtime to drive the buddy and pi-job-listener. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: any, ctx: any) => unknown;
type Extension = (pi: any) => void;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `csb-buddy-${name}-`));
}

export interface Step {
  /** A tool to call in the first turn. */
  tool?: { name: string; args: Record<string, unknown> };
  /** Time the model "takes" after the tool returns, before its final reply. */
  thinkMs?: number;
  reply?: string;
}

/**
 * Loads extensions in order, fires pi's events at them, and records every state the buddy writes.
 * Mirrors pi where it matters: handlers run in load order and are awaited, `isIdle()` is false
 * while a run streams, and a run triggered during `agent_settled` waits until every settle
 * handler has finished.
 */
export function createHost(extensions: Extension[], buddyDir: string) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const wakes: string[] = [];
  const states: string[] = [];
  let streaming = false;
  let settling = false;
  const deferred: (() => Promise<void>)[] = [];
  let runs = Promise.resolve();
  let calls = 0;

  const ctx = {
    mode: "tui",
    model: { provider: "claude-bridge" },
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => !streaming,
  };

  const statePath = join(buddyDir, `${process.pid}.json`);
  function state(): string | undefined {
    try { return JSON.parse(readFileSync(statePath, "utf8")).state; } catch { return undefined; }
  }
  function record() {
    const current = state();
    if (current && current !== states[states.length - 1]) states.push(current);
  }

  async function emit(name: string, event: any = {}) {
    for (const handler of handlers.get(name) ?? []) {
      await handler({ type: name, ...event }, ctx);
      record();
    }
  }

  /** A wake starts a run: now when idle, after the settle handlers when settling. */
  function trigger(text: string) {
    const start = () => run({ reply: `Read ${text.split("\n")[0]}` });
    if (settling) deferred.push(start);
    else if (!streaming) runs = runs.then(start);
  }

  const pi = {
    on: (name: string, handler: Handler) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name)!.push(handler);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    sendMessage: (message: any, options?: { triggerTurn?: boolean }) => {
      wakes.push(String(message.content));
      if (options?.triggerTurn) trigger(String(message.content));
    },
  };
  for (const extension of extensions) extension(pi);

  async function run(step: Step = {}): Promise<any> {
    streaming = true;
    await emit("before_agent_start");
    await emit("agent_start");
    await emit("turn_start");
    let result: any;
    if (step.tool) {
      const toolCallId = `call-${++calls}`;
      const { name, args } = step.tool;
      await emit("tool_execution_start", { toolCallId, toolName: name, args });
      result = await tools.get(name).execute(toolCallId, args, undefined, undefined, ctx);
      await emit("tool_execution_end", { toolCallId, toolName: name, result, isError: !!result.isError });
      await emit("turn_end");
      if (step.thinkMs) await sleep(step.thinkMs);
      await emit("turn_start");
    }
    await emit("message_end", {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: step.reply ?? "Done." }] },
    });
    await emit("turn_end");
    streaming = false;
    await emit("agent_before_settle", { outcome: "completed" });
    settling = true;
    await emit("agent_settled", { aborted: false });
    settling = false;
    for (const start of deferred.splice(0)) runs = runs.then(start);
    return result;
  }

  return {
    ctx,
    wakes,
    states,
    state,
    record,
    emit,
    run,
    start: () => emit("session_start"),
    stop: () => emit("session_shutdown"),
    /** Runs started by wakes, including ones they trigger in turn. */
    idle: async () => { let last; do { last = runs; await last; } while (last !== runs); },
  };
}

/** Poll until `check` holds, recording states meanwhile so heartbeat changes are seen. */
export async function waitFor(check: () => boolean, record: () => void, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
    record();
  }
}
