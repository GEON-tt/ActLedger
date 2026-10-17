import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKAgent, SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { NOTE_TOOL_DEFS, NOTE_TOOL_NAMES, type NoteToolName } from "../tools.js";
import type { Provider } from "./types.js";

const EXAMPLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const INSTRUCTIONS = [
  "你是笔记助手，只能使用 list_notes 和 send_note。",
  "send_note 会停在工具内部，等用户在审批页批准后才写入；工具返回 sent 之前，不要说已经发出。被拒绝时如实告诉用户没有发送。",
  "不要使用 shell，不要改文件。",
].join("\n");

export async function createCursorProvider(env: NodeJS.ProcessEnv): Promise<Provider> {
  const { Agent, CursorAgentError } = await import("@cursor/sdk");
  const apiKey = env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("ACTLEDGER_DEMO_PROVIDER=cursor needs CURSOR_API_KEY in the environment");

  let current: import("../tools.js").TurnTools | null = null;
  let agent: SDKAgent | null = null;
  const customTools: Record<string, SDKCustomTool> = {};
  for (const name of NOTE_TOOL_NAMES) {
    const toolName: NoteToolName = name;
    customTools[toolName] = {
      description: NOTE_TOOL_DEFS[toolName].description,
      inputSchema: NOTE_TOOL_DEFS[toolName].inputSchema as Record<string, SDKJsonValue>,
      execute: async (args) => {
        if (!current) return { content: [{ type: "text", text: "no active turn" }], isError: true };
        const result = await current.call(toolName, args);
        return result.ok ? result.output : { content: [{ type: "text", text: result.output }], isError: true };
      },
    };
  }

  return {
    name: "cursor",
    async runTurn(history, tools, emit) {
      current = tools;
      try {
        agent ??= await Agent.create({
          apiKey,
          model: { id: "grok-4.7" },
          tools: ["mcp"],
          local: { cwd: EXAMPLE_DIR, settingSources: [], customTools },
        });
        const prompt = `${INSTRUCTIONS}\n用户说：${history.at(-1)?.text ?? ""}`;
        const run = await agent.send(prompt);
        let text = "";
        for await (const event of run.stream()) {
          if (event.type === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "text") {
                text += block.text;
                emit({ type: "text", text: block.text });
              }
            }
          } else if (event.type === "status" && event.status === "ERROR") {
            emit({ type: "error", message: event.message ?? "cursor run error" });
          }
        }
        const result = await run.wait();
        if (result.status === "error") emit({ type: "error", message: result.error?.message ?? "cursor run error" });
        return { text };
      } catch (error) {
        if (error instanceof CursorAgentError) throw new Error(error.message);
        throw error;
      } finally {
        current = null;
      }
    },
    async close() {
      if (agent) await agent[Symbol.asyncDispose]();
    },
  };
}
