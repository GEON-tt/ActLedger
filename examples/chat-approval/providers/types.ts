import type { TurnTools } from "../tools.js";

export type ProviderName = "fake" | "cursor" | "claude" | "openai";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export type ProviderEvent = { type: "text"; text: string } | { type: "error"; message: string };

export interface Provider {
  readonly name: ProviderName;
  /** history 的最后一条是这一轮的用户消息。返回这一轮助手的完整文字（写进 history）。 */
  runTurn(
    history: ChatMessage[],
    tools: TurnTools,
    emit: (event: ProviderEvent) => void,
  ): Promise<{ text: string }>;
  close(): Promise<void>;
}
