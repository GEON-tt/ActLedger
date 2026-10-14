import { parseDurationMs } from "../time.js";
import { matches } from "./match.js";
import type { EvalContext } from "./match.js";
import {
  HIGH_RISK_LEVELS,
  assuranceRank,
  globMatch,
  type ActionLevel,
  type CoverageEntry,
  type Effect,
  type LoadedPolicy,
  type PolicyRule,
  type ResolvedDefaults,
  type StepUp,
  type UserAssurance,
} from "./schema.js";

export interface ActionRequest {
  type: string;
  resource?: string;
  blastRadius?: "self" | "others" | "public";
  reversible?: boolean;
  amount?: { value: number; currency: string };
  attrs?: Record<string, unknown>;
}

export interface Decision {
  result: Effect;
  ruleId: string;
  policyVersion: number;
  ladderLevel: number;
  minAssurance: UserAssurance | null;
  integrationMode: "recorded" | "enforced";
  coverageVia: string | null;
  coverageMatched: boolean;
  contentMode: "strict" | "warn";
  allowEdit: boolean;
  stepUp: string | null;
  channels: string[];
  executionTimeoutMs: number;
  claimDeadlineMs: number;
  approvalTimeoutMs: number;
  promotionHint: Record<string, unknown> | null;
  level: ActionLevel | null;
  blastRadius: "self" | "others" | "public";
  reversible: boolean;
}

function coverageFor(entries: CoverageEntry[], actionType: string): CoverageEntry | undefined {
  return entries.find((entry) => globMatch(entry.action, actionType));
}

interface ApprovalShape {
  channels?: string[];
  timeout?: string;
  allow_edit?: boolean;
  min_assurance?: UserAssurance;
  step_up?: StepUp | null;
}

/** Defaults first. A key present on the rule replaces that field, including an explicit null. */
function mergedApproval(rule: PolicyRule | undefined, defaults: ResolvedDefaults): ApprovalShape {
  const merged: ApprovalShape = {
    channels: defaults.channels,
    timeout: defaults.approvalTimeout,
    allow_edit: defaults.allowEdit,
    min_assurance: defaults.minAssurance,
    step_up: defaults.stepUp,
  };
  const written = rule?.approval;
  if (!written) return merged;
  if ("channels" in written) merged.channels = written.channels;
  if ("timeout" in written) merged.timeout = written.timeout;
  if ("allow_edit" in written) merged.allow_edit = written.allow_edit;
  if ("min_assurance" in written) merged.min_assurance = written.min_assurance;
  if ("step_up" in written) merged.step_up = written.step_up ?? null;
  return merged;
}

function resolveStepUp(step: StepUp | null | undefined, ctx: EvalContext): string | null {
  if (step == null) return null;
  if (typeof step === "string") return step;
  return matches(step.when, ctx) ? step.method : null;
}

function minAssuranceFor(
  effect: Effect,
  level: ActionLevel | null,
  rule: PolicyRule | undefined,
  fallback: UserAssurance,
): UserAssurance | null {
  if (effect !== "require_approval") return null;
  if (rule?.approval && "min_assurance" in rule.approval && rule.approval.min_assurance) {
    return rule.approval.min_assurance;
  }
  if (level && HIGH_RISK_LEVELS.has(level)) {
    return assuranceRank(fallback) >= assuranceRank("channel_verified") ? fallback : "channel_verified";
  }
  return fallback;
}

export function evaluate(policy: LoadedPolicy, action: ActionRequest, ctxBase: {
  hour: number;
  grantLevel?: number;
  tags?: string[];
  policyVersion: number;
}): Decision {
  const catalog = policy.doc.actions?.[action.type];
  const level = catalog?.level ?? null;
  const ctx: EvalContext = {
    actionType: action.type,
    level,
    attrs: action.attrs ?? {},
    amount: action.amount ?? null,
    time: { hour: ctxBase.hour },
    grant: { ladder_level: ctxBase.grantLevel ?? 0 },
    principal: { tags: ctxBase.tags ?? [] },
  };
  const rule = (policy.doc.rules ?? []).find((candidate) => matches(candidate.match, ctx));
  const effect = rule?.effect ?? policy.defaults.unknownAction;
  const coverage = coverageFor(policy.doc.coverage ?? [], action.type);
  const merged = mergedApproval(rule, policy.defaults);
  const timeout = merged.timeout ?? policy.defaults.approvalTimeout;
  const executionTimeout = rule?.execution_timeout ?? policy.defaults.executionTimeout;
  return {
    result: effect,
    ruleId: rule?.id ?? `default:${policy.defaults.unknownAction}`,
    policyVersion: ctxBase.policyVersion,
    ladderLevel: ctxBase.grantLevel ?? 0,
    minAssurance: minAssuranceFor(effect, level, rule, policy.defaults.minAssurance),
    integrationMode: coverage?.mode ?? "recorded",
    coverageVia: coverage?.via ?? null,
    coverageMatched: Boolean(coverage),
    contentMode: policy.defaults.contentMode,
    allowEdit: merged.allow_edit ?? policy.defaults.allowEdit,
    stepUp: effect === "require_approval" ? resolveStepUp(merged.step_up, ctx) : null,
    channels: merged.channels ?? policy.defaults.channels,
    executionTimeoutMs: parseDurationMs(executionTimeout),
    claimDeadlineMs: parseDurationMs(policy.defaults.claimDeadline),
    approvalTimeoutMs: parseDurationMs(timeout),
    promotionHint: rule?.ladder?.promote_hint ?? null,
    level,
    blastRadius: action.blastRadius ?? catalog?.blast_radius ?? "self",
    reversible: action.reversible ?? catalog?.reversible ?? true,
  };
}
