import type { Provider, ProviderName } from "./types.js";

export const PROVIDER_NAMES: readonly ProviderName[] = ["fake", "cursor", "claude", "openai"];

export const PROVIDER_KEYS = {
  cursor: ["CURSOR_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ACTLEDGER_DEMO_CLAUDE_LOGIN"],
  openai: ["OPENAI_API_KEY"],
} as const;

const SUGGESTIONS = [
  { key: "CURSOR_API_KEY", name: "cursor", label: "Cursor (grok-4.7)" },
  { key: "ANTHROPIC_API_KEY", name: "claude", label: "Claude" },
  { key: "OPENAI_API_KEY", name: "openai", label: "OpenAI" },
] as const;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export function resolveProviderName(env: NodeJS.ProcessEnv): { name: ProviderName; suggestion: string | null } {
  const raw = env.ACTLEDGER_DEMO_PROVIDER?.trim() ?? "";
  if (raw === "") {
    for (const item of SUGGESTIONS) {
      const value = env[item.key];
      if (typeof value === "string" && value.trim() !== "") {
        return {
          name: "fake",
          suggestion: `tip: ${item.key} is set; restart with ACTLEDGER_DEMO_PROVIDER=${item.name} to use ${item.label}`,
        };
      }
    }
    return { name: "fake", suggestion: null };
  }
  if (!isProviderName(raw)) {
    throw new Error(`ACTLEDGER_DEMO_PROVIDER must be one of fake, cursor, claude, openai (got "${raw}")`);
  }
  return { name: raw, suggestion: null };
}

export function assertProviderReady(name: ProviderName, env: NodeJS.ProcessEnv): void {
  if (name === "fake") return;
  if (name === "cursor") {
    if (blank(env.CURSOR_API_KEY)) {
      throw new Error("ACTLEDGER_DEMO_PROVIDER=cursor needs CURSOR_API_KEY in the environment");
    }
    return;
  }
  if (name === "claude") {
    const declared = env.ACTLEDGER_DEMO_CLAUDE_LOGIN === "1";
    if (blank(env.ANTHROPIC_API_KEY) && blank(env.CLAUDE_CODE_OAUTH_TOKEN) && !declared) {
      throw new Error(
        "ACTLEDGER_DEMO_PROVIDER=claude needs ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ACTLEDGER_DEMO_CLAUDE_LOGIN=1 if Claude Code is already logged in on this machine",
      );
    }
    return;
  }
  if (blank(env.OPENAI_API_KEY)) {
    throw new Error("ACTLEDGER_DEMO_PROVIDER=openai needs OPENAI_API_KEY in the environment");
  }
}

export async function loadProvider(name: ProviderName, env: NodeJS.ProcessEnv): Promise<Provider> {
  assertProviderReady(name, env);
  switch (name) {
    case "fake":
      return (await import("./fake.js")).createFakeProvider();
    case "cursor":
      return (await import("./cursor.js")).createCursorProvider(env);
    case "claude":
      return (await import("./claude.js")).createClaudeProvider(env);
    case "openai":
      return (await import("./openai.js")).createOpenAIProvider(env);
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown provider ${exhaustive}`);
    }
  }
}
