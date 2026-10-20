import { createRequire } from "node:module";
import type {
  Agent,
  FunctionTool,
  RunContext,
  RunResult,
  RunState,
  RunToolApprovalItem,
  Tool,
  ToolInputParameters,
  ToolOptions,
} from "@openai/agents";
import {
  approveHint,
  type Ledger,
  type Payload,
  type Run,
  type ToolGate,
  type ToolGateOutcome,
} from "@actledger/sdk";

/** The string the OpenAI Agents SDK returns when a tool throws and no errorFunction is set. */
export const SDK_DEFAULT_TOOL_ERROR = "An error occurred while running the tool. Please try again.";

export interface OpenAIAgentsLedgerErrorContext {
  phase: "before" | "resolve" | "resume" | "after" | "abandon";
  toolName: string;
  callId: string | undefined;
}

export type OpenAIAgentsLedgerEntry =
  | { kind: "pending"; taskId: string }
  | { kind: "deny"; taskId: string; reason: string; message: string }
  | { kind: "error"; message: string };

export interface OpenAIAgentsLedgerStore {
  get(key: string): OpenAIAgentsLedgerEntry | undefined;
  set(key: string, entry: OpenAIAgentsLedgerEntry): void;
  delete(key: string): void;
}

export interface OpenAIAgentsLedgerOptions {
  /** Must be defer mode. */
  gate: ToolGate;
  /** The same Ledger the gate uses. Only sweep() and getTask() are called. */
  ledger: Ledger;
  toolInput?: (approvedPayload: Payload, sdkInput: unknown, toolName: string) => unknown;
  executedPayload?: (approvedPayload: Payload, toolInput: unknown, toolName: string) => Payload;
  /** Used only when withLedger wraps an existing FunctionTool. Default: output equals the SDK default error string. */
  isToolError?: (output: unknown, toolName: string) => boolean;
  store?: OpenAIAgentsLedgerStore;
  onError?: (error: unknown, context: OpenAIAgentsLedgerErrorContext) => void;
  /** withLedgerAgent reports tools that are not function tools (hosted, computer, shell, apply_patch). */
  onUnsupportedTool?: (tool: Tool) => void;
}

export interface OpenAIAgentsLedger {
  readonly gate: ToolGate;
  /** How many auto-approved runs are claimed and still waiting for invoke. */
  readonly inFlight: number;
  /** Fail every held run with code "abandoned". */
  abandon(reason?: string): Promise<void>;
}

export interface ResolvedInterruptions {
  state: RunState<any, any>;
  approved: RunToolApprovalItem[];
  rejected: Array<{ item: RunToolApprovalItem; taskId: string | null; reason: string }>;
  pending: Array<{ item: RunToolApprovalItem; taskId: string; approveHint: string }>;
  untracked: RunToolApprovalItem[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const require = createRequire(import.meta.url);

function loadTool(): typeof import("@openai/agents").tool {
  return (require("@openai/agents") as typeof import("@openai/agents")).tool;
}

type ToolCallDetails = Parameters<FunctionTool["invoke"]>[2];

type HeldRun = { run: Run | null; approvedPayload: Payload };

interface Internals {
  gate: ToolGate;
  ledger: Ledger;
  held: Map<string, HeldRun>;
  store: OpenAIAgentsLedgerStore;
  toolInput: (approvedPayload: Payload, sdkInput: unknown, toolName: string) => unknown;
  executedPayload: (approvedPayload: Payload, toolInput: unknown, toolName: string) => Payload;
  isToolError: (output: unknown, toolName: string) => boolean;
  onError?: (error: unknown, context: OpenAIAgentsLedgerErrorContext) => void;
  onUnsupportedTool?: (tool: Tool) => void;
}

type Prepared =
  | { ok: true; run: Run | null; approvedPayload: Payload }
  | { ok: false; message: string };

class MemoryStore implements OpenAIAgentsLedgerStore {
  private readonly map = new Map<string, OpenAIAgentsLedgerEntry>();

  get(key: string): OpenAIAgentsLedgerEntry | undefined {
    return this.map.get(key);
  }

  set(key: string, entry: OpenAIAgentsLedgerEntry): void {
    this.map.set(key, entry);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

const boxes = new WeakMap<OpenAIAgentsLedger, Internals>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

/** Key-sorted JSON comparison. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function normalizeForCompare(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function ledgerArgs(sdkInput: unknown): unknown {
  const normalized = normalizeForCompare(sdkInput);
  return isPlainObject(normalized) ? normalized : sdkInput;
}

function defaultToolInput(approvedPayload: Payload, sdkInput: unknown, _toolName: string): unknown {
  if (isPlainObject(approvedPayload.args) && !sameJson(approvedPayload.args, normalizeForCompare(sdkInput))) {
    return approvedPayload.args;
  }
  return sdkInput;
}

function defaultExecutedPayload(approvedPayload: Payload, _toolInput: unknown, _toolName: string): Payload {
  return approvedPayload;
}

function defaultIsToolError(output: unknown, _toolName: string): boolean {
  return output === SDK_DEFAULT_TOOL_ERROR;
}

export function denyMessage(toolName: string, reason: string, taskId: string | null): string {
  return `ActLedger did not allow ${toolName}: ${reason} (task ${taskId}).`;
}

export class ActLedgerToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActLedgerToolError";
  }
}

function internals(binding: OpenAIAgentsLedger): Internals {
  const box = boxes.get(binding);
  if (!box) throw new TypeError("unknown OpenAI agents ledger binding");
  return box;
}

function report(box: Internals, error: unknown, context: OpenAIAgentsLedgerErrorContext): void {
  box.onError?.(error, context);
}

function keyFor(toolName: string, callId: string): string {
  return `${toolName}:${callId}`;
}

function callIdOf(details: ToolCallDetails): string | undefined {
  const call = details?.toolCall;
  if (!call || typeof call !== "object" || !("callId" in call)) return undefined;
  const callId = call.callId;
  return typeof callId === "string" && callId.length > 0 ? callId : undefined;
}

function hasParse(parameters: unknown): parameters is { parse: (value: unknown) => unknown } {
  return isPlainObject(parameters) && typeof parameters.parse === "function";
}

function argsWereEdited(approvedPayload: Payload, sdkInput: unknown): boolean {
  return isPlainObject(approvedPayload.args) && !sameJson(approvedPayload.args, normalizeForCompare(sdkInput));
}

async function safeAfter(
  box: Internals,
  run: Run | null,
  outcome: ToolGateOutcome,
  context: OpenAIAgentsLedgerErrorContext,
): Promise<void> {
  if (run === null) return;
  try {
    await box.gate.after(run, outcome);
  } catch (error) {
    if (!box.onError) throw error;
    report(box, error, context);
  }
}

function makeNeedsApproval(binding: OpenAIAgentsLedger, toolName: string) {
  return async (_ctx: RunContext, input: unknown, callId?: string): Promise<boolean> => {
    if (!callId) return true;
    const box = internals(binding);
    const key = keyFor(toolName, callId);
    if (box.held.has(key)) return false;
    if (box.store.get(key)) return true;
    try {
      const decision = await box.gate.before(toolName, ledgerArgs(input) as Record<string, unknown>);
      if (decision.kind === "allow") {
        box.held.set(key, { run: decision.run, approvedPayload: decision.approvedPayload });
        return false;
      }
      if (decision.kind === "pending") {
        box.store.set(key, { kind: "pending", taskId: decision.taskId });
        return true;
      }
      box.store.set(key, {
        kind: "deny",
        taskId: decision.taskId,
        reason: decision.reason,
        message: denyMessage(toolName, decision.reason, decision.taskId),
      });
      return true;
    } catch (error) {
      report(box, error, { phase: "before", toolName, callId });
      box.store.set(key, { kind: "error", message: denyMessage(toolName, "ledger_error", null) });
      return true;
    }
  };
}

async function prepareExecution(
  binding: OpenAIAgentsLedger,
  toolName: string,
  sdkInput: unknown,
  callId: string | undefined,
): Promise<Prepared> {
  if (!callId) {
    throw new ActLedgerToolError("no callId; run the tool through the Agents SDK runner");
  }
  const box = internals(binding);
  const key = keyFor(toolName, callId);
  const held = box.held.get(key);
  if (held) {
    box.held.delete(key);
    box.store.delete(key);
    return { ok: true, run: held.run, approvedPayload: held.approvedPayload };
  }
  const entry = box.store.get(key);
  if (entry?.kind === "pending") {
    try {
      const decision = await box.gate.resume(entry.taskId);
      if (decision.kind === "allow") {
        box.store.delete(key);
        return { ok: true, run: decision.run, approvedPayload: decision.approvedPayload };
      }
      box.store.delete(key);
      if (decision.kind === "deny") {
        return { ok: false, message: denyMessage(toolName, decision.reason, decision.taskId) };
      }
      return {
        ok: false,
        message: `${denyMessage(toolName, "pending", decision.taskId)} ${decision.approveHint}`,
      };
    } catch (error) {
      box.store.delete(key);
      report(box, error, { phase: "resume", toolName, callId });
      return { ok: false, message: denyMessage(toolName, "ledger_error", entry.taskId) };
    }
  }
  if (entry?.kind === "deny" || entry?.kind === "error") {
    return { ok: false, message: entry.message };
  }
  try {
    const decision = await box.gate.before(toolName, ledgerArgs(sdkInput) as Record<string, unknown>);
    if (decision.kind === "allow") {
      box.store.delete(key);
      return { ok: true, run: decision.run, approvedPayload: decision.approvedPayload };
    }
    if (decision.kind === "pending") {
      return {
        ok: false,
        message: `${denyMessage(toolName, "pending", decision.taskId)} ${decision.approveHint}`,
      };
    }
    return { ok: false, message: denyMessage(toolName, decision.reason, decision.taskId) };
  } catch (error) {
    report(box, error, { phase: "before", toolName, callId });
    return { ok: false, message: denyMessage(toolName, "ledger_error", null) };
  }
}

async function parsedToolInput(
  box: Internals,
  prepared: Extract<Prepared, { ok: true }>,
  sdkInput: unknown,
  toolName: string,
  callId: string,
  parameters: unknown,
): Promise<unknown> {
  const chosen = box.toolInput(prepared.approvedPayload, sdkInput, toolName);
  if (!argsWereEdited(prepared.approvedPayload, sdkInput) || !hasParse(parameters)) return chosen;
  const toParse = isPlainObject(chosen) ? chosen : prepared.approvedPayload.args;
  try {
    return parameters.parse(toParse);
  } catch (error) {
    await safeAfter(
      box,
      prepared.run,
      { error, code: "invalid_approved_input" },
      { phase: "after", toolName, callId },
    );
    throw error;
  }
}

function invokeInput(chosen: unknown, sdkInput: unknown, edited: boolean): string {
  if (!edited && chosen === sdkInput && typeof sdkInput === "string") return sdkInput;
  if (!edited && typeof sdkInput === "string" && sameJson(chosen, normalizeForCompare(sdkInput))) return sdkInput;
  if (typeof chosen === "string") return chosen;
  return JSON.stringify(chosen);
}

type ErrorFunction = (context: RunContext, error: unknown, details?: ToolCallDetails) => unknown;

function composeErrorFunction(user: unknown): ErrorFunction | null {
  if (user === null) return null;
  const userFn = typeof user === "function" ? (user as ErrorFunction) : undefined;
  return (context, error, details) => {
    if (error instanceof ActLedgerToolError) return error.message;
    if (userFn) return userFn(context, error, details);
    return SDK_DEFAULT_TOOL_ERROR;
  };
}

function parametersOf(options: object): unknown {
  if (!("parameters" in options)) return undefined;
  return options.parameters;
}

function errorFunctionOf(options: object): unknown {
  if (!("errorFunction" in options)) return undefined;
  return options.errorFunction;
}

function isToolTimeoutReason(reason: unknown): reason is Error {
  return reason instanceof Error && reason.name === "ToolTimeoutError";
}

function signalCode(signal: AbortSignal): "cancelled" | "aborted" {
  return isToolTimeoutReason(signal.reason) ? "cancelled" : "aborted";
}

/** Matches the Agents SDK default when timeoutBehavior is error_as_result. */
function sdkTimeoutMessage(toolName: string, timeoutMs: number): string {
  return `Tool '${toolName}' timed out after ${timeoutMs}ms.`;
}

function whenAborted(signal: AbortSignal, onAbort: () => void): { done: Promise<void>; stop: () => void } {
  if (signal.aborted) {
    onAbort();
    return { done: Promise.resolve(), stop: () => {} };
  }
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const listener = () => {
    onAbort();
    resolveDone();
  };
  signal.addEventListener("abort", listener, { once: true });
  return { done, stop: () => signal.removeEventListener("abort", listener) };
}

function abortResult<T>(signal: AbortSignal): T {
  if (isToolTimeoutReason(signal.reason)) return signal.reason.message as T;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(signalCode(signal));
}

/**
 * Record the tool outcome. A timeout or abort fails the run once.
 * The SDK races timeoutMs and does not cancel the underlying promise, so a
 * later success must not call complete after that fail.
 */
async function finishToolCall<T>(args: {
  box: Internals;
  run: Run | null;
  toolName: string;
  callId: string | undefined;
  signal: AbortSignal | undefined;
  timeoutMs?: number;
  executedPayload: Payload;
  invoke: () => Promise<T>;
  toolError?: (output: T) => { error: unknown; code: string } | undefined;
}): Promise<T> {
  const context: OpenAIAgentsLedgerErrorContext = { phase: "after", toolName: args.toolName, callId: args.callId };
  let closing: Promise<void> | undefined;
  const fail = (error: unknown, code: string): Promise<void> => {
    closing ??= safeAfter(args.box, args.run, { error, code }, context).then(() => undefined);
    return closing;
  };
  const signal = args.signal;
  if (signal?.aborted) {
    await fail(signal.reason ?? new Error(signalCode(signal)), signalCode(signal));
    return abortResult(signal);
  }
  const abortWait = signal
    ? whenAborted(signal, () => {
        void fail(signal.reason ?? new Error(signalCode(signal)), signalCode(signal)).catch(() => {});
      })
    : undefined;
  const invocation = Promise.resolve()
    .then(args.invoke)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    const winner = abortWait
      ? await Promise.race([
          invocation.then((settled) => ({ kind: "settled" as const, settled })),
          abortWait.done.then(() => ({ kind: "abort" as const })),
        ])
      : { kind: "settled" as const, settled: await invocation };
    if (winner.kind === "abort" || signal?.aborted) {
      const code = signal ? signalCode(signal) : "aborted";
      await fail(signal?.reason ?? new Error(code), code);
      if (!signal) throw new Error(code);
      return abortResult(signal);
    }
    const settled = winner.settled;
    if (!settled.ok) {
      if (isToolTimeoutReason(settled.error)) {
        await fail(settled.error, "cancelled");
        throw settled.error;
      }
      if (signal?.aborted) {
        await fail(signal.reason ?? settled.error, signalCode(signal));
        return abortResult(signal);
      }
      await fail(settled.error, "tool_error");
      throw settled.error;
    }
    if (closing || signal?.aborted) {
      const code = signal ? signalCode(signal) : "cancelled";
      await fail(signal?.reason ?? new Error(code), code);
      return settled.value;
    }
    if (typeof args.timeoutMs === "number" && settled.value === sdkTimeoutMessage(args.toolName, args.timeoutMs)) {
      await fail(settled.value, "cancelled");
      return settled.value;
    }
    const toolError = args.toolError?.(settled.value);
    if (toolError) {
      await fail(toolError.error, toolError.code);
      return settled.value;
    }
    if (closing || signal?.aborted) {
      const code = signal ? signalCode(signal) : "cancelled";
      await fail(signal?.reason ?? new Error(code), code);
      return settled.value;
    }
    closing = safeAfter(
      args.box,
      args.run,
      { result: settled.value, executedPayload: args.executedPayload },
      context,
    ).then(() => undefined);
    await closing;
    return settled.value;
  } finally {
    abortWait?.stop();
  }
}

/**
 * Mount a defer-mode ToolGate on the OpenAI Agents SDK.
 * The binding does not approve or reject ledger tasks.
 */
export function createOpenAIAgentsLedger(options: OpenAIAgentsLedgerOptions): OpenAIAgentsLedger {
  if (options.gate.mode !== "defer") {
    throw new TypeError("openai agents adapter needs a defer-mode ToolGate");
  }
  const box: Internals = {
    gate: options.gate,
    ledger: options.ledger,
    held: new Map(),
    store: options.store ?? new MemoryStore(),
    toolInput: options.toolInput ?? defaultToolInput,
    executedPayload: options.executedPayload ?? defaultExecutedPayload,
    isToolError: options.isToolError ?? defaultIsToolError,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onUnsupportedTool ? { onUnsupportedTool: options.onUnsupportedTool } : {}),
  };
  const binding: OpenAIAgentsLedger = {
    gate: options.gate,
    get inFlight() {
      return box.held.size;
    },
    abandon(reason?: string) {
      return abandon(binding, reason);
    },
  };
  boxes.set(binding, box);
  return binding;
}

async function abandon(binding: OpenAIAgentsLedger, reason?: string): Promise<void> {
  const box = internals(binding);
  const message = reason ?? "run abandoned before the tool executed";
  const pending = [...box.held.entries()];
  box.held.clear();
  let failure: unknown;
  for (const [key, held] of pending) {
    if (!held.run) continue;
    const colon = key.indexOf(":");
    const context: OpenAIAgentsLedgerErrorContext = {
      phase: "abandon",
      toolName: colon === -1 ? key : key.slice(0, colon),
      callId: colon === -1 ? undefined : key.slice(colon + 1),
    };
    try {
      await held.run.fail({ error: { code: "abandoned", message } });
    } catch (error) {
      if (box.onError) report(box, error, context);
      else if (failure === undefined) failure = error;
    }
  }
  if (failure !== undefined) throw failure;
}

export function ledgerTool<
  TParameters extends ToolInputParameters = undefined,
  Context = unknown,
  Result = string,
>(
  options: DistributiveOmit<ToolOptions<TParameters, Context>, "needsApproval">,
  binding: OpenAIAgentsLedger,
): FunctionTool<Context, TParameters, Result> {
  if ((options as { needsApproval?: unknown }).needsApproval !== undefined) {
    throw new TypeError("ledgerTool owns needsApproval; remove it from the options");
  }
  const ref = { name: "" };
  const parameters = parametersOf(options);
  const execute = (options as { execute: (input: unknown, ctx?: RunContext<Context>, details?: ToolCallDetails) => Promise<Result> | Result }).execute;
  const created = loadTool()({
    ...(options as object),
    needsApproval: (ctx: RunContext, input: unknown, callId?: string) =>
      makeNeedsApproval(binding, ref.name)(ctx, input, callId),
    execute: async (input: unknown, ctx?: RunContext<Context>, details?: ToolCallDetails) => {
      const callId = callIdOf(details);
      const prepared = await prepareExecution(binding, ref.name, input, callId);
      if (!prepared.ok) throw new ActLedgerToolError(prepared.message);
      const box = internals(binding);
      const resolvedCallId = callId ?? "";
      const finalInput = await parsedToolInput(box, prepared, input, ref.name, resolvedCallId, parameters);
      const timeoutMs = "timeoutMs" in options && typeof options.timeoutMs === "number" ? options.timeoutMs : undefined;
      return finishToolCall({
        box,
        run: prepared.run,
        toolName: ref.name,
        callId,
        signal: details?.signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        executedPayload: box.executedPayload(prepared.approvedPayload, finalInput, ref.name),
        invoke: () => Promise.resolve(execute(finalInput, ctx, details)),
      });
    },
    errorFunction: composeErrorFunction(errorFunctionOf(options)),
  } as ToolOptions<TParameters, Context>);
  ref.name = created.name;
  return created as FunctionTool<Context, TParameters, Result>;
}

async function invokeWrapped<Context, TParameters extends ToolInputParameters, Result>(
  binding: OpenAIAgentsLedger,
  original: FunctionTool<Context, TParameters, Result>,
  ctx: RunContext<Context>,
  input: string,
  details?: ToolCallDetails,
): Promise<string | Result> {
  const callId = callIdOf(details);
  const prepared = await prepareExecution(binding, original.name, input, callId);
  if (!prepared.ok) {
    if (original.outputSchema) throw new ActLedgerToolError(prepared.message);
    return prepared.message;
  }
  const box = internals(binding);
  const edited = argsWereEdited(prepared.approvedPayload, input);
  const chosen = box.toolInput(prepared.approvedPayload, input, original.name);
  const callInput = invokeInput(chosen, input, edited);
  return finishToolCall({
    box,
    run: prepared.run,
    toolName: original.name,
    callId,
    signal: details?.signal,
    ...(typeof original.timeoutMs === "number" ? { timeoutMs: original.timeoutMs } : {}),
    executedPayload: box.executedPayload(prepared.approvedPayload, chosen, original.name),
    invoke: () => original.invoke(ctx, callInput, details),
    toolError: (output) => {
      if (!box.isToolError(output, original.name)) return undefined;
      return { error: typeof output === "string" ? output : SDK_DEFAULT_TOOL_ERROR, code: "tool_error" };
    },
  });
}

/** Wrap an existing function tool. Its own needsApproval is replaced by the ledger policy. */
export function withLedger<Context, TParameters extends ToolInputParameters, Result>(
  original: FunctionTool<Context, TParameters, Result>,
  binding: OpenAIAgentsLedger,
): FunctionTool<Context, TParameters, Result> {
  if (original?.type !== "function") throw new TypeError("withLedger only wraps function tools");
  return {
    ...original,
    needsApproval: makeNeedsApproval(binding, original.name),
    invoke: (ctx, input, details) => invokeWrapped(binding, original, ctx, input, details),
  };
}

/** Clone the agent, wrapping every function tool. Other tools stay as they are. */
export function withLedgerAgent<TAgent extends Agent<any, any>>(agent: TAgent, binding: OpenAIAgentsLedger): TAgent {
  const box = internals(binding);
  return agent.clone({
    tools: agent.tools.map((item) => {
      if (item.type === "function") return withLedger(item, binding);
      box.onUnsupportedTool?.(item);
      return item;
    }),
  }) as TAgent;
}

function stateOf(value: RunResult<any, any> | RunState<any, any>): RunState<any, any> {
  if (typeof (value as RunState<any, any>).getInterruptions === "function") return value as RunState<any, any>;
  return (value as RunResult<any, any>).state;
}

function functionCallOf(item: RunToolApprovalItem): { name: string; callId: string } | undefined {
  const raw = item.rawItem;
  if (raw.type !== "function_call" || !item.name || !raw.callId) return undefined;
  return { name: item.name, callId: raw.callId };
}

function reasonOf(handle: { state: string; decision: { result: string } } | null): string {
  if (!handle) return "not_found";
  if (handle.state === "rejected" && handle.decision.result === "deny") return "policy_denied";
  return handle.state;
}

/**
 * Read the ledger, then call the SDK's state.approve or state.reject.
 * Does not resume the gate and does not claim.
 */
export async function resolveInterruptions(
  resultOrState: RunResult<any, any> | RunState<any, any>,
  binding: OpenAIAgentsLedger,
): Promise<ResolvedInterruptions> {
  const state = stateOf(resultOrState);
  const box = internals(binding);
  const approved: RunToolApprovalItem[] = [];
  const rejected: ResolvedInterruptions["rejected"] = [];
  const pending: ResolvedInterruptions["pending"] = [];
  const untracked: RunToolApprovalItem[] = [];
  box.ledger.sweep();
  for (const item of [...state.getInterruptions()]) {
    const call = functionCallOf(item);
    if (!call) {
      untracked.push(item);
      continue;
    }
    const entry = box.store.get(keyFor(call.name, call.callId));
    if (!entry) {
      untracked.push(item);
      continue;
    }
    if (entry.kind === "deny") {
      state.reject(item, { message: entry.message });
      box.store.delete(keyFor(call.name, call.callId));
      rejected.push({ item, taskId: entry.taskId, reason: entry.reason });
      continue;
    }
    if (entry.kind === "error") {
      state.reject(item, { message: entry.message });
      box.store.delete(keyFor(call.name, call.callId));
      rejected.push({ item, taskId: null, reason: "ledger_error" });
      continue;
    }
    let handle;
    try {
      handle = await box.ledger.getTask(entry.taskId);
    } catch (error) {
      report(box, error, { phase: "resolve", toolName: call.name, callId: call.callId });
      pending.push({ item, taskId: entry.taskId, approveHint: approveHint(entry.taskId, box.ledger.dir) });
      continue;
    }
    if (handle?.state === "approved") {
      state.approve(item);
      approved.push(item);
      continue;
    }
    if (handle?.state === "pending_approval") {
      pending.push({ item, taskId: entry.taskId, approveHint: approveHint(entry.taskId, box.ledger.dir, handle.decision) });
      continue;
    }
    const reason = reasonOf(handle);
    state.reject(item, { message: denyMessage(call.name, reason, entry.taskId) });
    box.store.delete(keyFor(call.name, call.callId));
    rejected.push({ item, taskId: entry.taskId, reason });
  }
  return { state, approved, rejected, pending, untracked };
}
