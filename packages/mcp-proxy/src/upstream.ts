import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type UpstreamOutcome =
  | { kind: "ok"; result: CallToolResult }
  | { kind: "tool_error"; result: CallToolResult }
  | { kind: "rpc_error"; message: string }
  | { kind: "unverified" }
  | { kind: "timeout" }
  | { kind: "disconnected" };

type CallReturn = Awaited<ReturnType<Client["callTool"]>>;

function isCallResult(value: CallReturn): value is CallToolResult {
  return Array.isArray((value as { content?: unknown }).content);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "upstream call failed";
}

export class Upstream {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private aliveFlag = false;

  constructor(
    private readonly opts: {
      command: string;
      args: string[];
      cwd?: string;
      envPassthrough: string[];
      onToolsChanged: () => void;
    },
  ) {}

  get alive(): boolean {
    return this.aliveFlag;
  }

  cachedTools(): Tool[] {
    return this.tools;
  }

  async connect(): Promise<void> {
    const env = getDefaultEnvironment();
    for (const name of this.opts.envPassthrough) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
      env,
      stderr: "inherit",
    });
    transport.onclose = () => {
      this.aliveFlag = false;
    };
    const client = new Client({ name: "actledger-mcp-proxy", version: "0.1.0" });
    client.onclose = () => {
      this.aliveFlag = false;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      this.opts.onToolsChanged();
    });
    this.transport = transport;
    this.client = client;
    await client.connect(transport);
    this.aliveFlag = true;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client) throw new McpError(ErrorCode.ConnectionClosed, "upstream is not connected");
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<UpstreamOutcome> {
    if (!this.client || !this.aliveFlag) return { kind: "disconnected" };
    const timeout = Math.max(1, timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const pending = this.client
      .request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, {
        timeout,
        signal: controller.signal,
        resetTimeoutOnProgress: false,
      })
      .then(
        (result) => ({ settled: "result" as const, result }),
        (error: unknown) => ({ settled: "error" as const, error }),
      );
    const aborted = new Promise<{ settled: "error"; error: unknown }>((resolve) => {
      const fail = () => resolve({ settled: "error", error: Object.assign(new Error("timeout"), { name: "AbortError" }) });
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    try {
      const winner = await Promise.race([pending, aborted]);
      if (winner.settled === "error") return this.classify(winner.error, controller.signal.aborted);
      return this.classifyResult(name, winner.result);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.aliveFlag = false;
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) await client.close().catch(() => undefined);
  }

  private classify(error: unknown, aborted: boolean): UpstreamOutcome {
    if (aborted || (error instanceof Error && error.name === "AbortError")) return { kind: "timeout" };
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { kind: "timeout" };
    if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
      this.aliveFlag = false;
      return { kind: "disconnected" };
    }
    if (!this.aliveFlag) return { kind: "disconnected" };
    if (error instanceof McpError) return { kind: "rpc_error", message: messageOf(error).slice(0, 500) };
    return { kind: "unverified" };
  }

  private classifyResult(name: string, result: CallReturn): UpstreamOutcome {
    if (!isCallResult(result)) return { kind: "unverified" };
    if (result.isError) return { kind: "tool_error", result };
    if (this.outputUnverified(name, result)) return { kind: "unverified" };
    return { kind: "ok", result };
  }

  private outputUnverified(name: string, result: CallToolResult): boolean {
    const tool = this.tools.find((item) => item.name === name);
    if (!tool?.outputSchema) return false;
    if (!result.structuredContent) return true;
    const validate = (
      this.client as { getToolOutputValidator?(toolName: string): ((data: unknown) => { valid: boolean }) | undefined } | null
    )?.getToolOutputValidator?.(name);
    if (!validate) return true;
    try {
      return !validate(result.structuredContent).valid;
    } catch {
      return true;
    }
  }
}
