import {
  assuranceRank,
  effectiveChannels,
  type LedgerEngine,
  type Receipt,
  type TaskView,
} from "@actledger/core";
import { statusTone, type DecisionInfo, type ListRow, type TaskPage, type TimelineRow } from "./html.js";
import { t, tv, type ConsoleVariant, type Locale } from "./i18n.js";

export type TaskTab = "pending" | "recent" | "all";

export function taskTab(value: string | null): TaskTab | null {
  if (value === null) return "pending";
  if (value === "pending" || value === "recent" || value === "all") return value;
  return null;
}

export function tabTasks(tasks: TaskView[], tab: TaskTab): TaskView[] {
  if (tab === "pending") return tasks.filter((task) => task.state === "pending_approval");
  if (tab === "recent") {
    return tasks
      .filter((task) => task.approvalId !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, 50);
  }
  return [...tasks].reverse().slice(0, 200);
}

export function tabCounts(tasks: TaskView[]): Record<TaskTab, number> {
  return {
    pending: tasks.filter((task) => task.state === "pending_approval").length,
    recent: Math.min(50, tasks.filter((task) => task.approvalId !== null).length),
    all: Math.min(200, tasks.length),
  };
}

export function listRow(engine: LedgerEngine, task: TaskView, at: Date): ListRow {
  return {
    id: task.id,
    type: task.action.type,
    level: task.action.level ?? "",
    state: task.state,
    principalId: task.principalId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt ?? "",
    expired: isExpired(task.expiresAt, at),
    intent: clip(shownIntent(engine, task.id, "(unavailable)"), 120),
    args: shownArgs(engine, task.id, false),
  };
}

export function taskJson(engine: LedgerEngine, task: TaskView, at: Date): Record<string, unknown> {
  const row = listRow(engine, task, at);
  return {
    id: row.id,
    state: row.state,
    action: { type: task.action.type, level: task.action.level, resource: task.action.resource },
    principalId: row.principalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: task.expiresAt,
    expired: isExpired(task.expiresAt, at),
    decided: task.approvalId !== null,
    intent: row.intent,
    args: row.args,
  };
}

export function approvalGate(
  task: TaskView,
  approver: string | undefined,
  locale: Locale,
  variant: ConsoleVariant = "local",
): { hints: string[]; approveDisabled: boolean; rejectDisabled: boolean } {
  const hints: string[] = [];
  let approveDisabled = false;
  let rejectDisabled = false;
  if (!effectiveChannels(task.decision).includes("web")) {
    hints.push(tv(locale, variant, "hint.channel"));
    approveDisabled = true;
    rejectDisabled = true;
  }
  if (task.decision.minAssurance && assuranceRank(task.decision.minAssurance) > assuranceRank("app_asserted")) {
    const min = task.decision.minAssurance;
    hints.push(tv(locale, variant, "hint.assurance", { min, id: task.id }));
    approveDisabled = true;
  }
  if (task.decision.stepUp) {
    hints.push(tv(locale, variant, "hint.stepUp", { stepUp: task.decision.stepUp, id: task.id }));
    approveDisabled = true;
  }
  if (approver && approver !== task.principalId) {
    hints.push(t(locale, "hint.approver"));
    approveDisabled = true;
    rejectDisabled = true;
  }
  return { hints, approveDisabled, rejectDisabled };
}

export function detailPage(
  engine: LedgerEngine,
  task: TaskView,
  opts: { csrf: string; locale: Locale; at: Date; approver?: string; variant?: ConsoleVariant },
): TaskPage {
  const variant = opts.variant ?? "local";
  const gate = approvalGate(task, opts.approver, opts.locale, variant);
  let rows: TimelineRow[] = [];
  let decided: DecisionInfo | null = null;
  try {
    const receipts = engine.listTaskReceipts(task.id);
    rows = timeline(receipts, opts.locale);
    decided = decisionInfo(receipts);
  } catch {
    rows = [];
    decided = null;
  }
  return {
    id: task.id,
    state: task.state,
    principalId: task.principalId,
    agentId: task.agentId ?? "",
    createdAt: task.createdAt,
    expiresAt: task.expiresAt ?? "",
    expired: isExpired(task.expiresAt, opts.at),
    level: task.action.level ?? "",
    actionType: task.action.type,
    action: JSON.stringify(task.action, null, 2),
    intent: shownIntent(engine, task.id, "(unavailable: shredded)"),
    payload: shownPayload(engine, task.id),
    ruleId: task.decision.ruleId,
    result: task.decision.result,
    minAssurance: task.decision.minAssurance ?? "",
    stepUp: task.decision.stepUp ?? "",
    channels: effectiveChannels(task.decision).join(", "),
    payloadHash: task.payloadHash,
    pending: task.state === "pending_approval",
    hints: gate.hints,
    approveDisabled: gate.approveDisabled,
    rejectDisabled: gate.rejectDisabled,
    csrf: opts.csrf,
    args: shownArgs(engine, task.id, true),
    allowEdit: task.decision.allowEdit,
    approvedPayloadEdited: task.approvedPayloadHash !== null && task.approvedPayloadHash !== task.payloadHash,
    approvedPayloadHash: task.approvedPayloadHash ?? "",
    decisionInfo: decided,
    timeline: rows,
  };
}

export function shownIntent(engine: LedgerEngine, id: string, fallback: string): string {
  try {
    return engine.taskIntent(id) ?? "";
  } catch {
    return fallback;
  }
}

export function shownPayload(engine: LedgerEngine, id: string): string {
  try {
    return JSON.stringify(engine.taskPayload(id), null, 2);
  } catch {
    return "(unavailable)";
  }
}

function shownArgs(engine: LedgerEngine, id: string, pretty: boolean): string {
  try {
    const args = engine.taskPayload(id).args;
    const text = pretty ? JSON.stringify(args, null, 2) : JSON.stringify(args);
    if (typeof text !== "string") return "(unavailable)";
    return pretty ? text : clip(text, 120);
  } catch {
    return "(unavailable)";
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isExpired(expiresAt: string | null, at: Date): boolean {
  if (!expiresAt) return false;
  return at.getTime() > new Date(expiresAt).getTime();
}

function timeline(receipts: Receipt[], locale: Locale): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const receipt of receipts) {
    if (!receipt.transition) continue;
    const to = receipt.transition.to;
    const from = receipt.transition.from;
    const body = receipt.body;
    let label = to;
    let detail = "";
    if (to === "prepared" && from === null) {
      label = t(locale, "tl.requested");
    } else if (to === "pending_approval") {
      label = t(locale, "tl.pending");
      detail = t(locale, "tl.rule", { rule: policyRule(body) });
    } else if (to === "approved" && receipt.actor.type === "policy") {
      label = t(locale, "tl.approvedPolicy");
      detail = t(locale, "tl.rule", { rule: receipt.actor.id });
    } else if (to === "approved") {
      label = t(locale, "tl.approved");
      detail = approvalDetail(body, locale);
    } else if (to === "rejected" && receipt.actor.type === "policy") {
      label = t(locale, "tl.deniedPolicy");
      detail = t(locale, "tl.reason", { reason: textField(body.reason) ?? "" });
    } else if (to === "rejected") {
      label = t(locale, "tl.rejected");
      detail = approvalDetail(body, locale);
      if (typeof body.note_commit === "string") detail += t(locale, "tl.reasonRecorded");
    } else if (to === "drafted") {
      label = t(locale, "tl.drafted");
    } else if (to === "executing") {
      label = t(locale, "tl.claimed");
    } else if (to === "executed") {
      label = t(locale, "tl.completed");
    } else if (to === "failed") {
      label = t(locale, "tl.failed");
      const code = textField(recordField(body.error)?.code);
      if (code) detail = t(locale, "tl.error", { code });
    } else if (to === "unknown" || to === "expired" || to === "revoked") {
      label = t(locale, to === "unknown" ? "tl.unknown" : to === "expired" ? "tl.expired" : "tl.revoked");
      const reason = textField(body.reason);
      if (reason) detail = t(locale, "tl.reason", { reason });
    }
    rows.push({
      at: receipt.issued_at,
      seq: receipt.seq,
      label,
      actor: `${receipt.actor.type}:${receipt.actor.id}`,
      detail,
      tone: statusTone(to),
    });
  }
  return rows;
}

function decisionInfo(receipts: Receipt[]): DecisionInfo | null {
  for (let i = receipts.length - 1; i >= 0; i--) {
    const receipt = receipts[i];
    if (!receipt?.transition) continue;
    const to = receipt.transition.to;
    if (to !== "approved" && to !== "rejected") continue;
    if (receipt.actor.type !== "user") continue;
    const approval = recordField(receipt.body.approval);
    if (!approval) continue;
    const auth = recordField(approval.auth);
    return {
      decision: to === "approved" ? "approved" : "rejected",
      approver: textField(approval.approver) ?? "",
      channel: textField(approval.channel) ?? "",
      assurance: textField(approval.assurance) ?? "",
      simulated: auth?.simulated === true,
      decidedAt: textField(approval.decided_at) ?? "",
      noteRecorded: typeof receipt.body.note_commit === "string",
    };
  }
  return null;
}

function approvalDetail(body: Record<string, unknown>, locale: Locale): string {
  const approval = recordField(body.approval);
  if (!approval) return "";
  const auth = recordField(approval.auth);
  let detail = t(locale, "tl.approval", {
    approver: textField(approval.approver) ?? "",
    channel: textField(approval.channel) ?? "",
    assurance: textField(approval.assurance) ?? "",
  });
  if (auth?.simulated === true) detail += t(locale, "tl.simulated");
  return detail;
}

function policyRule(body: Record<string, unknown>): string {
  return textField(recordField(body.policy)?.rule_id) ?? "";
}

function textField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
