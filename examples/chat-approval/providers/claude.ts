import { MCP_SERVER_NAME, NOTE_TOOL_DEFS } from "../tools.js";
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

function textBlock(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export async function createClaudeProvider(_env: NodeJS.ProcessEnv): Promise<Provider> {
  const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const { createClaudeAgentAdapter } = await import("@actledger/claude-agent-sdk");
  const { z } = await import("zod");

  return {
    name: "claude",
    async runTurn(history, tools, emit) {
      let text = "";
      const adapter = createClaudeAgentAdapter({
        gate: tools.gate("wait"),
        onError: (error) => emit({ type: "error", message: error instanceof Error ? error.message : String(error) }),
      });
      const server = createSdkMcpServer({
        name: MCP_SERVER_NAME,
        tools: [
          tool("list_notes", NOTE_TOOL_DEFS.list_notes.description, {}, async () => textBlock(tools.raw.list_notes())),
          tool("send_note", NOTE_TOOL_DEFS.send_note.description, { text: z.string() }, async (args) => {
            try {
              return textBlock(tools.raw.send_note(args));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { content: [{ type: "text" as const, text: message }], isError: true as const };
            }
          }),
        ],
      });
      try {
        for await (const message of query({
          prompt: transcript(history),
          options: adapter.options({
            systemPrompt: INSTRUCTIONS,
            tools: [],
            mcpServers: { [MCP_SERVER_NAME]: server },
            strictMcpConfig: true,
            settingSources: [],
            maxTurns: 6,
            permissionMode: "default",
          }),
        })) {
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text") {
                text += block.text;
                emit({ type: "text", text: block.text });
              }
            }
          }
          if (message.type === "result" && message.subtype !== "success") {
            emit({ type: "error", message: message.subtype });
          }
        }
      } finally {
        await adapter.abandon();
      }
      return { text };
    },
    async close() {},
  };
}
