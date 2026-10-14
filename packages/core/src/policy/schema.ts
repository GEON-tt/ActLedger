import { z } from "zod";
import { LedgerError } from "../errors.js";
import { hourInTimeZone, parseDurationMs } from "../time.js";

export const ACTION_LEVELS = ["read", "draft", "write", "send", "spend", "delete"] as const;
export type ActionLevel = (typeof ACTION_LEVELS)[number];

export const EFFECTS = ["allow", "require_approval", "deny", "draft_only"] as const;
export type Effect = (typeof EFFECTS)[number];

export const ASSURANCES = ["policy", "app_asserted", "channel_verified", "user_signed"] as const;
export type Assurance = (typeof ASSURANCES)[number];

export const USER_ASSURANCES = ["app_asserted", "channel_verified", "user_signed"] as const;
export type UserAssurance = (typeof USER_ASSURANCES)[number];

export const HIGH_RISK_LEVELS: ReadonlySet<ActionLevel> = new Set(["send", "spend", "delete"]);

export function isUserAssurance(value: unknown): value is UserAssurance {
  return value === "app_asserted" || value === "channel_verified" || value === "user_signed";
}

export function assuranceRank(assurance: string): number {
  switch (assurance) {
    case "policy":
      return 0;
    case "app_asserted":
      return 1;
    case "channel_verified":
      return 2;
    case "user_signed":
      return 3;
    default:
      return -1;
  }
}

const actionSpecSchema = z.object({
  level: z.enum(ACTION_LEVELS),
  blast_radius: z.enum(["self", "others", "public"]).optional(),
  reversible: z.boolean().optional(),
});

const stepUpSchema = z.union([
  z.string().min(1),
  z.object({
    when: z.record(z.unknown()),
    method: z.string().min(1),
  }),
]);

const approvalSchema = z.object({
  channels: z.array(z.string()).optional(),
  timeout: z.string().optional(),
  allow_edit: z.boolean().optional(),
  min_assurance: z.enum(USER_ASSURANCES).optional(),
  step_up: stepUpSchema.nullable().optional(),
});

const ruleSchema = z.object({
  id: z.string().min(1),
  match: z.record(z.unknown()),
  effect: z.enum(EFFECTS),
  approval: approvalSchema.optional(),
  execution_timeout: z.string().optional(),
  ladder: z
    .object({
      promote_hint: z.record(z.unknown()).optional(),
      demote_on: z.array(z.string()).optional(),
    })
    .optional(),
});

export const coverageSchema = z.object({
  action: z.string().min(1),
  mode: z.enum(["recorded", "enforced"]),
  via: z.string().min(1).optional(),
});

const defaultsSchema = z.object({
  unknown_action: z.enum(EFFECTS).optional(),
  timezone: z.string().optional(),
  content_mode: z.enum(["strict", "warn"]).optional(),
  approval: approvalSchema.optional(),
  claim_deadline: z.string().optional(),
  execution_timeout: z.string().optional(),
});

export const policyDocumentSchema = z.object({
  version: z.literal(1),
  defaults: defaultsSchema.optional(),
  coverage: z.array(coverageSchema).optional(),
  actions: z.record(actionSpecSchema).optional(),
  rules: z.array(ruleSchema).optional(),
});

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
export type PolicyRule = z.infer<typeof ruleSchema>;
export type CoverageEntry = z.infer<typeof coverageSchema>;
export type StepUp = z.infer<typeof stepUpSchema>;

export interface ResolvedDefaults {
  unknownAction: Effect;
  timezone: string;
  contentMode: "strict" | "warn";
  channels: string[];
  approvalTimeout: string;
  allowEdit: boolean;
  minAssurance: UserAssurance;
  stepUp: StepUp | null;
  claimDeadline: string;
  executionTimeout: string;
}

export interface PolicyWarning {
  code: "uncovered_high_risk" | "high_risk_low_assurance";
  action: string;
  level?: ActionLevel;
  message: string;
}

export interface LoadedPolicy {
  doc: PolicyDocument;
  defaults: ResolvedDefaults;
  warnings: PolicyWarning[];
}

const OPERATORS = new Set([
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "not_between",
  "glob",
  "exists",
]);

function assertNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LedgerError("policy_invalid", `${path} must be an integer`, 422);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNumbers(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertNumbers(child, `${path}.${key}`);
    }
  }
}

function assertMatchShape(match: Record<string, unknown>, path: string): void {
  for (const [key, expected] of Object.entries(match)) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) continue;
    const ops = Object.keys(expected);
    if (ops.length === 0) {
      throw new LedgerError("policy_invalid", `${path}.${key} is empty`, 422);
    }
    for (const op of ops) {
      if (!OPERATORS.has(op)) {
        throw new LedgerError("policy_invalid", `${path}.${key} has unknown operator ${op}`, 422);
      }
    }
    const record = expected as Record<string, unknown>;
    for (const op of ["gt", "gte", "lt", "lte"] as const) {
      if (op in record && typeof record[op] !== "number") {
        throw new LedgerError("policy_invalid", `${path}.${key}.${op} must be a number`, 422);
      }
    }
    for (const op of ["between", "not_between"] as const) {
      const range = record[op];
      if (range === undefined) continue;
      if (!Array.isArray(range) || range.length !== 2 || range.some((item) => typeof item !== "number")) {
        throw new LedgerError("policy_invalid", `${path}.${key}.${op} must be [low, high]`, 422);
      }
    }
    if ("in" in record && !Array.isArray(record.in)) {
      throw new LedgerError("policy_invalid", `${path}.${key}.in must be an array`, 422);
    }
    if ("not_in" in record && !Array.isArray(record.not_in)) {
      throw new LedgerError("policy_invalid", `${path}.${key}.not_in must be an array`, 422);
    }
    if ("glob" in record && typeof record.glob !== "string") {
      throw new LedgerError("policy_invalid", `${path}.${key}.glob must be a string`, 422);
    }
    if ("exists" in record && typeof record.exists !== "boolean") {
      throw new LedgerError("policy_invalid", `${path}.${key}.exists must be a boolean`, 422);
    }
  }
}

export function resolveDefaults(doc: PolicyDocument): ResolvedDefaults {
  const defaults = doc.defaults ?? {};
  const approval = defaults.approval ?? {};
  const resolved: ResolvedDefaults = {
    unknownAction: defaults.unknown_action ?? "require_approval",
    timezone: defaults.timezone ?? "UTC",
    contentMode: defaults.content_mode ?? "strict",
    channels: approval.channels ?? [],
    approvalTimeout: approval.timeout ?? "15m",
    allowEdit: approval.allow_edit ?? true,
    minAssurance: approval.min_assurance ?? "app_asserted",
    stepUp: approval.step_up === undefined ? null : approval.step_up,
    claimDeadline: defaults.claim_deadline ?? "24h",
    executionTimeout: defaults.execution_timeout ?? "15m",
  };
  parseDurationMs(resolved.approvalTimeout);
  parseDurationMs(resolved.claimDeadline);
  parseDurationMs(resolved.executionTimeout);
  hourInTimeZone(new Date(), resolved.timezone);
  return resolved;
}

export function validatePolicy(doc: PolicyDocument): PolicyWarning[] {
  assertNumbers(doc, "$");
  const ids = new Set<string>();
  for (const rule of doc.rules ?? []) {
    if (ids.has(rule.id)) {
      throw new LedgerError("policy_invalid", `duplicate rule id ${rule.id}`, 422);
    }
    ids.add(rule.id);
    if (rule.effect !== "require_approval" && rule.approval !== undefined) {
      throw new LedgerError(
        "policy_invalid",
        `rules.${rule.id}.approval is only allowed on require_approval rules`,
        422,
      );
    }
    assertMatchShape(rule.match, `rules.${rule.id}.match`);
    if (rule.approval?.timeout) parseDurationMs(rule.approval.timeout);
    if (rule.execution_timeout) parseDurationMs(rule.execution_timeout);
    if (rule.approval?.step_up && typeof rule.approval.step_up !== "string") {
      assertMatchShape(rule.approval.step_up.when, `rules.${rule.id}.approval.step_up.when`);
    }
  }
  const defaultStep = doc.defaults?.approval?.step_up;
  if (defaultStep && typeof defaultStep !== "string") {
    assertMatchShape(defaultStep.when, "defaults.approval.step_up.when");
  }
  const defaults = resolveDefaults(doc);
  const warnings: PolicyWarning[] = [];
  for (const [type, spec] of Object.entries(doc.actions ?? {})) {
    if (!HIGH_RISK_LEVELS.has(spec.level)) continue;
    const covered = (doc.coverage ?? []).some((entry) => globMatch(entry.action, type));
    if (!covered) {
      warnings.push({
        code: "uncovered_high_risk",
        action: type,
        level: spec.level,
        message: `${type} (${spec.level}) is not listed in coverage`,
      });
    }
  }
  void defaults;
  return warnings;
}

export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}
