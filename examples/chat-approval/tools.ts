import fs from "node:fs";
import path from "node:path";
import {
  createToolGate,
  type Ledger,
  type Run,
  type ToolGate,
  type ToolGateMapping,
  type ToolGateOutcome,
} from "@actledger/sdk";

export type NoteToolName = "list_notes" | "send_note";

export const NOTE_TOOL_NAMES: readonly NoteToolName[] = ["list_notes", "send_note"];
export const PRINCIPAL = "u_1";
export const AGENT_ID = "chat-approval";
export const MCP_SERVER_NAME = "notes";

export const NOTE_TOOL_DEFS: Record<NoteToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  list_notes: {
    description: "List notes that were actually sent. Read only. Never sends anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  send_note: {
    description:
      "Send a note to the team. Blocks until a person approves it in the ActLedger console; only then is the note written.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Note text, at most 2000 characters" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

export interface NoteRecord {
  text: string;
  at: string;
  taskId: string | null;
}

export type ToolEvent =
  | { type: "tool_call"; callId: string; tool: string; args: Record<string, unknown> }
  | { type: "approval_pending"; callId: string | null; taskId: string; tool: string }
  | {
      type: "tool_result";
      callId: string;
      tool: string;
      ok: boolean;
      taskId: string | null;
      reason: string | null;
      receiptHash: string | null;
      output: string;
    };

export interface NoteToolsOptions {
  ledger: Ledger;
  outbox: string;
  timeoutMs: number;
  pollMs: number;
}

export interface ToolCallResult {
  ok: boolean;
  output: string;
  taskId: string | null;
}

export interface TurnTools {
  readonly ledger: Ledger;
  readonly outbox: string;
  /** 函数内 gate（wait 模式）。fake 和 cursor 用。 */
  call(name: NoteToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** 给适配器用的、带观察包装的 gate。claude 用 "wait"，openai 用 "defer"。 */
  gate(mode: "wait" | "defer"): ToolGate;
  /** 只给适配器后面的工具函数体用；gate 已经由适配器处理过。 */
  raw: { list_notes(): string; send_note(args: unknown): string };
}

export interface NoteTools {
  forTurn(emit: (event: ToolEvent) => void): TurnTools;
}

/** "send_note" 和 "mcp__notes__send_note" 都返回 "send_note"；其他名字返回 null。 */
export function noteToolName(raw: string): NoteToolName | null {
  const name = raw.replace(/^mcp__notes__/, "");
  return (NOTE_TOOL_NAMES as readonly string[]).includes(name) ? (name as NoteToolName) : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function noteMapping(raw: string, input: Record<string, unknown>): ToolGateMapping {
  const name = noteToolName(raw);
  const type = name ? `tool.${name}` : `tool.${raw}`;
  if (name === "send_note") {
    const args = { text: typeof input.text === "string" ? input.text : "" };
    return {
      action: { type },
      payload: { action: type, args },
      intent: `send note: ${clip(args.text, 80)}`,
    };
  }
  if (name === "list_notes") {
    return { action: { type }, payload: { action: type, args: {} }, intent: "list notes" };
  }
  return { action: { type }, payload: { action: type, args: input } };
}

function mappingArgs(raw: string, input: Record<string, unknown>): Record<string, unknown> {
  const args = noteMapping(raw, input).payload?.args;
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  return {};
}

export function readNotes(outbox: string): NoteRecord[] {
  if (!fs.existsSync(outbox)) return [];
  const notes: NoteRecord[] = [];
  for (const line of fs.readFileSync(outbox, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Partial<NoteRecord>;
    notes.push({
      text: typeof value.text === "string" ? value.text : "",
      at: typeof value.at === "string" ? value.at : "",
      taskId: typeof value.taskId === "string" ? value.taskId : null,
    });
  }
  return notes;
}

export function listNotesRaw(outbox: string): string {
  return JSON.stringify(readNotes(outbox));
}

export function sendNoteRaw(outbox: string, args: unknown, taskId: string | null): string {
  const text =
    args && typeof args === "object" && !Array.isArray(args) && typeof (args as { text?: unknown }).text === "string"
      ? (args as { text: string }).text.trim()
      : "";
  if (text.length < 1 || text.length > 2000) {
    throw new Error("send_note needs text of 1 to 2000 characters");
  }
  fs.mkdirSync(path.dirname(outbox), { recursive: true });
  const record: NoteRecord = { text, at: new Date().toISOString(), taskId };
  fs.appendFileSync(outbox, `${JSON.stringify(record)}\n`);
  return `sent: ${text}`;
}

export function observeGate(inner: ToolGate, emit: (event: ToolEvent) => void): ToolGate {
  const tasks = new Map<string, { callId: string; tool: string }>();
  const runs = new Map<Run, { callId: string; tool: string }>();
  let seq = 0;
  const nextId = () => `c${++seq}`;

  function apply(decision: Awaited<ReturnType<ToolGate["before"]>>, callId: string, tool: string): void {
    if (decision.kind === "allow") {
      if (decision.run) runs.set(decision.run, { callId, tool });
      if (decision.taskId) tasks.set(decision.taskId, { callId, tool });
      return;
    }
    if (decision.kind === "pending") {
      tasks.set(decision.taskId, { callId, tool });
      emit({ type: "approval_pending", callId, taskId: decision.taskId, tool });
      return;
    }
    emit({
      type: "tool_result",
      callId,
      tool,
      ok: false,
      taskId: decision.taskId,
      reason: decision.reason,
      receiptHash: null,
      output: decision.message,
    });
  }

  return {
    get mode() {
      return inner.mode;
    },
    async before(raw, input) {
      const callId = nextId();
      const tool = noteToolName(raw) ?? raw;
      emit({ type: "tool_call", callId, tool, args: mappingArgs(raw, input) });
      try {
        const decision = await inner.before(raw, input);
        apply(decision, callId, tool);
        return decision;
      } catch (error) {
        emit({
          type: "tool_result",
          callId,
          tool,
          ok: false,
          taskId: null,
          reason: "ledger_error",
          receiptHash: null,
          output: messageOf(error),
        });
        throw error;
      }
    },
    async resume(taskId) {
      const known = tasks.get(taskId);
      const callId = known?.callId ?? nextId();
      const tool = known?.tool ?? "unknown";
      try {
        const decision = await inner.resume(taskId);
        apply(decision, callId, tool);
        return decision;
      } catch (error) {
        emit({
          type: "tool_result",
          callId,
          tool,
          ok: false,
          taskId,
          reason: "ledger_error",
          receiptHash: null,
          output: messageOf(error),
        });
        throw error;
      }
    },
    async after(run, outcome: ToolGateOutcome) {
      const receipt = await inner.after(run, outcome);
      const known = run ? runs.get(run) : undefined;
      if (run) runs.delete(run);
      const failed = "error" in outcome;
      emit({
        type: "tool_result",
        callId: known?.callId ?? nextId(),
        tool: known?.tool ?? "unknown",
        ok: !failed,
        taskId: run?.taskId ?? null,
        reason: failed ? (outcome.code ?? "tool_error") : null,
        receiptHash: receipt?.hash ?? null,
        output: clip(String(failed ? outcome.error : outcome.result), 200),
      });
      return receipt;
    },
  };
}

async function callTool(
  gate: ToolGate,
  name: NoteToolName,
  args: Record<string, unknown>,
  outbox: string,
): Promise<ToolCallResult> {
  let decision;
  try {
    decision = await gate.before(name, args);
  } catch {
    return { ok: false, output: `${name} was not performed: ledger error`, taskId: null };
  }
  if (decision.kind === "deny") {
    return {
      ok: false,
      taskId: decision.taskId,
      output: `${name} was not performed: ${decision.reason} (task ${decision.taskId}). ${decision.message}. Tell the user it was not done.`,
    };
  }
  if (decision.kind === "pending") {
    return {
      ok: false,
      taskId: decision.taskId,
      output: `${name} was not performed: pending (task ${decision.taskId}). ${decision.approveHint}. Tell the user it was not done.`,
    };
  }
  if (decision.run === null) {
    return { ok: false, output: `${name} was not performed: ledger unavailable`, taskId: null };
  }
  const run = decision.run;
  const approved = decision.approvedPayload.args;
  let output: string;
  try {
    output = name === "send_note" ? sendNoteRaw(outbox, approved, run.taskId) : listNotesRaw(outbox);
  } catch (error) {
    await gate.after(run, { error, code: "tool_error" });
    return { ok: false, output: `${name} failed: ${messageOf(error)}`, taskId: run.taskId };
  }
  await gate.after(run, { result: output });
  return { ok: true, output, taskId: run.taskId };
}

export function createNoteTools(opts: NoteToolsOptions): NoteTools {
  const common = { ledger: opts.ledger, principal: PRINCIPAL, agentId: AGENT_ID, map: noteMapping };
  const waitGate = createToolGate({ ...common, mode: "wait", timeoutMs: opts.timeoutMs, pollMs: opts.pollMs });
  const deferGate = createToolGate({ ...common, mode: "defer" });
  return {
    forTurn(emit) {
      const observedWait = observeGate(waitGate, emit);
      let observedDefer: ToolGate | null = null;
      return {
        ledger: opts.ledger,
        outbox: opts.outbox,
        call: (name, args) => callTool(observedWait, name, args, opts.outbox),
        gate(mode) {
          if (mode === "wait") return observedWait;
          observedDefer ??= observeGate(deferGate, emit);
          return observedDefer;
        },
        raw: {
          list_notes: () => listNotesRaw(opts.outbox),
          send_note: (args) => sendNoteRaw(opts.outbox, args, null),
        },
      };
    },
  };
}
