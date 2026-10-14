import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
  PermissionResult,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { Payload, Run, ToolGate, ToolGateDeny, ToolGateOutcome, ToolGatePending } from "@actledger/sdk";

/** onError 的调用现场。before 失败即拒绝；after 有 onError 才吞掉异常。 */
export interface ClaudeAgentAdapterErrorContext {
  phase: "before" | "after" | "abort" | "abandon";
  toolName: string;
  toolUseId: string | undefined;
}

export interface ClaudeAgentAdapterOptions {
  /** 必须是 wait 模式。 */
  gate: ToolGate;
  /** 由审批后的载荷算出交给工具的 input。默认：approvedPayload.args 是普通对象时用它，否则用原 input。 */
  toolInput?: (approvedPayload: Payload, input: Record<string, unknown>, toolName: string) => Record<string, unknown>;
  /** 默认 approvedPayload。不从 tool_input 重算，避免 SDK 补默认字段后在 strict 模式下误报 ContentMismatch。 */
  executedPayload?: (approvedPayload: Payload, toolInput: unknown, toolName: string) => Payload;
  /** PostToolUse 里判定工具其实失败了。默认 isPlainObject(r) && r.isError === true。 */
  isToolError?: (toolResponse: unknown) => boolean;
  /** deny 时是否带 interrupt: true。默认 false。 */
  interruptOnDeny?: boolean;
  /** 传给 HookCallbackMatcher.matcher，默认不设（匹配所有工具）。 */
  matcher?: string;
  /** post 钩子 matcher 的 timeout（秒），默认不设，沿用 SDK 默认。 */
  hookTimeoutSec?: number;
  onError?: (error: unknown, context: ClaudeAgentAdapterErrorContext) => void;
  /** 工具没经过 canUseTool（allowedTools、bypassPermissions、degraded）时通知。 */
  onUntracked?: (toolName: string, toolUseId: string | undefined) => void;
}

export interface ClaudeAgentAdapter {
  readonly canUseTool: CanUseTool;
  readonly hooks: {
    PostToolUse: HookCallbackMatcher[];
    PostToolUseFailure: HookCallbackMatcher[];
  };
  /** 合并进现有 Options：已设 canUseTool 或 permissionPromptToolName 时抛 TypeError；hooks 按事件拼接（用户已有的在前）。 */
  options(base?: Options): Options;
  /** 还在等 post 钩子的 run 数量。 */
  readonly inFlight: number;
  /** fail 掉所有 in-flight run，code "abandoned"。 */
  abandon(reason?: string): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorTextOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** MCP CallToolResult 带 isError 时，取第一段 text；没有就用固定句子。 */
function toolErrorText(toolResponse: unknown): string {
  if (isPlainObject(toolResponse) && Array.isArray(toolResponse.content)) {
    for (const item of toolResponse.content) {
      if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") return item.text;
    }
  }
  return "tool returned isError";
}

function defaultToolInput(
  approvedPayload: Payload,
  input: Record<string, unknown>,
  _toolName: string,
): Record<string, unknown> {
  if (isPlainObject(approvedPayload.args)) return approvedPayload.args;
  return input;
}

function defaultExecutedPayload(approvedPayload: Payload, _toolInput: unknown, _toolName: string): Payload {
  return approvedPayload;
}

function defaultIsToolError(toolResponse: unknown): boolean {
  return isPlainObject(toolResponse) && toolResponse.isError === true;
}

function denied(message: string, interrupt: boolean): PermissionResult {
  if (interrupt) return { behavior: "deny", message, interrupt: true };
  return { behavior: "deny", message };
}

/** deny / pending 的人类可读句子。异常路径不走这里，那边没有 task id。 */
export function denyMessage(toolName: string, decision: ToolGateDeny | ToolGatePending): string {
  if (decision.kind === "pending") {
    return `ActLedger did not allow ${toolName}: pending (task ${decision.taskId}). ${decision.approveHint}`;
  }
  return `ActLedger did not allow ${toolName}: ${decision.reason} (task ${decision.taskId}). ${decision.message}. Tell the user this action was not performed.`;
}

/**
 * 把 wait 模式的 ToolGate 挂到 Claude Agent SDK 的 canUseTool / PostToolUse / PostToolUseFailure。
 * 不挂 PreToolUse：那个钩子返回 allow 会跳过 canUseTool。
 * 适配器不提供 approve / reject。
 */
export function createClaudeAgentAdapter(opts: ClaudeAgentAdapterOptions): ClaudeAgentAdapter {
  if (opts.gate.mode !== "wait") throw new TypeError("claude adapter needs a wait-mode ToolGate");

  const inflight = new Map<string, { run: Run; toolName: string }>();
  const toolInput = opts.toolInput ?? defaultToolInput;
  const executedPayload = opts.executedPayload ?? defaultExecutedPayload;
  const isToolError = opts.isToolError ?? defaultIsToolError;
  const interrupt = opts.interruptOnDeny ?? false;

  function report(error: unknown, context: ClaudeAgentAdapterErrorContext): void {
    opts.onError?.(error, context);
  }

  async function settleQuietly(run: Run, outcome: ToolGateOutcome, context: ClaudeAgentAdapterErrorContext): Promise<void> {
    try {
      await opts.gate.after(run, outcome);
    } catch (error) {
      report(error, context);
    }
  }

  async function track(id: string, toolName: string, run: Run): Promise<void> {
    const prev = inflight.get(id);
    if (prev) {
      inflight.delete(id);
      await settleQuietly(
        prev.run,
        { error: "superseded by a new permission request", code: "superseded" },
        { phase: "before", toolName: prev.toolName, toolUseId: id },
      );
    }
    inflight.set(id, { run, toolName });
  }

  async function decide(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<PermissionResult> {
    let decision;
    try {
      decision = await opts.gate.before(toolName, input);
    } catch (error) {
      report(error, { phase: "before", toolName, toolUseId });
      return denied(`ActLedger did not allow ${toolName}: ledger error. ${errorTextOf(error)}`, interrupt);
    }
    if (decision.kind === "allow") {
      if (decision.run === null) return { behavior: "allow", updatedInput: input };
      await track(toolUseId, toolName, decision.run);
      return { behavior: "allow", updatedInput: toolInput(decision.approvedPayload, input, toolName) };
    }
    return denied(denyMessage(toolName, decision), interrupt);
  }

  // canUseTool 不能取消 gate.before。abort 先把 deny 交回去，后台再把已经 claim 的 run fail 掉。
  const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
    if (signal.aborted) return denied(`ActLedger did not allow ${toolName}: aborted.`, interrupt);
    const work = decide(toolName, input, toolUseID);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let first: PermissionResult | "aborted";
    try {
      first = await Promise.race([work, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (first !== "aborted") return first;
    void work
      .then(async () => {
        const tracked = inflight.get(toolUseID);
        if (!tracked) return;
        inflight.delete(toolUseID);
        await opts.gate.after(tracked.run, { error: "aborted before the tool ran", code: "aborted" });
      })
      .catch((error) => {
        try {
          report(error, { phase: "abort", toolName, toolUseId: toolUseID });
        } catch {
          // The permission callback has already returned. This chain must not reject.
        }
      });
    return denied(`ActLedger did not allow ${toolName}: aborted.`, interrupt);
  };

  async function take(toolName: string, id: string | undefined): Promise<{ run: Run; toolName: string } | undefined> {
    if (id === undefined) {
      opts.onUntracked?.(toolName, undefined);
      return undefined;
    }
    const tracked = inflight.get(id);
    if (!tracked) {
      opts.onUntracked?.(toolName, id);
      return undefined;
    }
    inflight.delete(id);
    return tracked;
  }

  async function afterOrReport(run: Run, outcome: ToolGateOutcome, context: ClaudeAgentAdapterErrorContext): Promise<HookJSONOutput> {
    try {
      await opts.gate.after(run, outcome);
      return {};
    } catch (error) {
      if (!opts.onError) throw error;
      report(error, context);
      return {};
    }
  }

  const postToolUse: HookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const hook: PostToolUseHookInput = input;
    const id = hook.tool_use_id ?? toolUseID;
    const tracked = await take(hook.tool_name, id);
    if (!tracked) return {};
    const outcome: ToolGateOutcome = isToolError(hook.tool_response)
      ? { error: toolErrorText(hook.tool_response), code: "tool_error" }
      : {
          result: hook.tool_response,
          executedPayload: executedPayload(tracked.run.approvedPayload, hook.tool_input, hook.tool_name),
        };
    return afterOrReport(tracked.run, outcome, { phase: "after", toolName: hook.tool_name, toolUseId: id });
  };

  const postToolUseFailure: HookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PostToolUseFailure") return {};
    const hook: PostToolUseFailureHookInput = input;
    const id = hook.tool_use_id ?? toolUseID;
    const tracked = await take(hook.tool_name, id);
    if (!tracked) return {};
    return afterOrReport(
      tracked.run,
      { error: hook.error, code: hook.is_interrupt ? "interrupted" : "tool_error" },
      { phase: "after", toolName: hook.tool_name, toolUseId: id },
    );
  };

  function matcherFor(hook: HookCallback): HookCallbackMatcher {
    const entry: HookCallbackMatcher = { hooks: [hook] };
    if (opts.matcher !== undefined) entry.matcher = opts.matcher;
    if (opts.hookTimeoutSec !== undefined) entry.timeout = opts.hookTimeoutSec;
    return entry;
  }

  const hooks = {
    PostToolUse: [matcherFor(postToolUse)],
    PostToolUseFailure: [matcherFor(postToolUseFailure)],
  };

  function options(base?: Options): Options {
    if (base?.canUseTool) throw new TypeError("options already has canUseTool");
    if (base?.permissionPromptToolName) throw new TypeError("options already has permissionPromptToolName");
    return {
      ...base,
      canUseTool,
      hooks: {
        ...base?.hooks,
        PostToolUse: [...(base?.hooks?.PostToolUse ?? []), ...hooks.PostToolUse],
        PostToolUseFailure: [...(base?.hooks?.PostToolUseFailure ?? []), ...hooks.PostToolUseFailure],
      },
    };
  }

  async function abandon(reason = "abandoned"): Promise<void> {
    const pending = [...inflight.entries()];
    inflight.clear();
    let failure: unknown;
    for (const [toolUseId, tracked] of pending) {
      try {
        await opts.gate.after(tracked.run, { error: reason, code: "abandoned" });
      } catch (error) {
        const context: ClaudeAgentAdapterErrorContext = { phase: "abandon", toolName: tracked.toolName, toolUseId };
        if (opts.onError) report(error, context);
        else if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  return {
    canUseTool,
    hooks,
    options,
    get inFlight() {
      return inflight.size;
    },
    abandon,
  };
}
