import { NOTE_TOOL_DEFS } from "../tools.js";
import type { ChatMessage, Provider } from "./types.js";

const INSTRUCTIONS = [
  "你是笔记助手，只能使用 list_notes 和 send_note。",
  "send_note 会停在工具内部，等用户在审批页批准后才写入；工具返回 sent 之前，不要说已经发出。被拒绝时如实告诉用户没有发送。",
  "不要使用 shell，不要改文件。",
].join("\n");

function transcript(history: ChatMessage[]): string {
  return history
    .slice(-20)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`)
    .join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createOpenAIProvider(env: NodeJS.ProcessEnv): Promise<Provider> {
  const { Agent, run, setTracingDisabled } = await import("@openai/agents");
  const { createOpenAIAgentsLedger, ledgerTool, resolveInterruptions } = await import("@actledger/openai-agents");
  const { z } = await import("zod");
  setTracingDisabled(true);

  return {
    name: "openai",
    async runTurn(history, tools, emit) {
      // The OpenAI adapter rejects wait mode; pending checks go through resolveInterruptions.
      const binding = createOpenAIAgentsLedger({ gate: tools.gate("defer"), ledger: tools.ledger });
      const agent = new Agent({
        name: "notes",
        instructions: INSTRUCTIONS,
        ...(env.OPENAI_DEFAULT_MODEL ? { model: env.OPENAI_DEFAULT_MODEL } : {}),
        tools: [
          ledgerTool(
            {
              name: "list_notes",
              description: NOTE_TOOL_DEFS.list_notes.description,
              parameters: z.object({}),
              execute: async () => tools.raw.list_notes(),
            },
            binding,
          ),
          ledgerTool(
            {
              name: "send_note",
              description: NOTE_TOOL_DEFS.send_note.description,
              parameters: z.object({ text: z.string() }),
              execute: async (args) => tools.raw.send_note(args),
            },
            binding,
          ),
        ],
      });
      try {
        let result = await run(agent, transcript(history), { maxTurns: 6 });
        const deadline = Date.now() + 15 * 60_000;
        while (result.interruptions.length > 0) {
          const resolved = await resolveInterruptions(result, binding);
          if (resolved.pending.length > 0) {
            if (Date.now() >= deadline) {
              emit({ type: "error", message: "approval still pending after 15 minutes" });
              break;
            }
            await sleep(1000);
            continue;
          }
          result = await run(agent, result.state, { maxTurns: 6 });
        }
        const out = `${result.finalOutput ?? ""}`;
        if (out) emit({ type: "text", text: out });
        return { text: out };
      } finally {
        await binding.abandon();
      }
    },
    async close() {},
  };
}
