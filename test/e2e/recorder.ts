/**
 * Loaded after the buddy: pi runs handlers in load order, so this reads the state the buddy has
 * just written at every step, with no polling gap for a short-lived state to hide in.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EVENTS = ["before_agent_start", "turn_start", "tool_execution_end", "message_end", "agent_settled"];

export default function recorder(pi: any) {
  const record = process.env.CSB_E2E_RECORD;
  const file = join(process.env.CSB_PI_BUDDY_DIR ?? "", `${process.pid}.json`);
  if (!record) return;
  for (const name of EVENTS) {
    pi.on(name, () => {
      let state: string | undefined;
      try { state = JSON.parse(readFileSync(file, "utf8")).state; } catch { /* not written yet */ }
      appendFileSync(record, `${JSON.stringify({ event: name, state, at: Date.now() })}\n`);
    });
  }
}
