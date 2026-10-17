/**
 * A scripted model registered as `claude-bridge`, so the buddy reports on a real pi session without
 * any model call. Each prompt word picks a scene; wakes from pi-job-listener get a short reply.
 */
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const server = `node -e "console.log('listening on 5173'); setInterval(() => {}, 1e9)"`;
const scenes: Record<string, { tool: string; args: Record<string, string | number>; thinkMs?: number }> = {
  quick: { tool: "bash", args: { command: "echo hi" } },
  build: { tool: "bash", args: { command: "sleep 2; echo built", stall_seconds: 30 } },
  // The job ends while the model is still busy, so its wake goes out from agent_settled.
  slowbuild: { tool: "bash", args: { command: "sleep 1; echo built", stall_seconds: 30 }, thinkMs: 2_500 },
  server: { tool: "bash", args: { command: server, stall_seconds: 1 } },
  stop: { tool: "jobs", args: { action: "kill" } },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (message: any): string => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).map((part: any) => (part.type === "text" ? part.text : "")).join("\n");

export default function scriptedProvider(pi: any) {
  const core = createFauxCore({ provider: "claude-bridge", api: "csb-buddy-scripted", models: [{ id: "scripted" }] });
  let pendingThink = 0;
  const respond = async (context: any) => {
    const last = context.messages.filter((message: any) => message.role !== "system").at(-1);
    if (last?.role === "toolResult") {
      await sleep(pendingThink);
      pendingThink = 0;
      return fauxAssistantMessage("Started.");
    }
    const said = text(last);
    if (said.includes("[job-")) return fauxAssistantMessage("Noted.");
    const scene = scenes[said.trim()];
    if (!scene) return fauxAssistantMessage("Done.");
    pendingThink = scene.thinkMs ?? 0;
    return fauxAssistantMessage([fauxText("On it."), fauxToolCall(scene.tool, scene.args)], { stopReason: "toolUse" });
  };
  // Enough scripted steps for every scene; each one reads the transcript to decide.
  core.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider("claude-bridge", {
    baseUrl: "scripted",
    apiKey: "not-used",
    api: core.api,
    models: [{
      id: "scripted", name: "Scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096,
    }],
    streamSimple: core.streamSimple,
  });
}
