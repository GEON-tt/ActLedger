import { globMatch, type ActionLevel, type PolicyRule } from "./schema.js";

export interface AmountRef {
  value: number;
  currency: string;
}

export interface EvalContext {
  actionType: string;
  level: ActionLevel | null;
  attrs: Record<string, unknown>;
  amount: AmountRef | null;
  time: { hour: number };
  grant: { ladder_level: number };
  principal: { tags: string[] };
}

export function resolvePath(ctx: EvalContext, path: string): { found: boolean; value: unknown } {
  if (path === "action") return { found: true, value: ctx.actionType };
  if (path === "level") {
    return ctx.level === null ? { found: false, value: undefined } : { found: true, value: ctx.level };
  }
  const [head, ...rest] = path.split(".");
  let current: unknown;
  if (head === "attrs") current = ctx.attrs;
  else if (head === "amount") current = ctx.amount;
  else if (head === "time") current = ctx.time;
  else if (head === "grant") current = ctx.grant;
  else if (head === "principal") current = ctx.principal;
  else return { found: false, value: undefined };
  if (rest.length === 0) {
    return current == null ? { found: false, value: undefined } : { found: true, value: current };
  }
  for (const part of rest) {
    if (!current || typeof current !== "object") return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function equals(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

function matchOperator(actual: { found: boolean; value: unknown }, expected: Record<string, unknown>): boolean {
  if ("exists" in expected) {
    if (expected.exists === true && !actual.found) return false;
    if (expected.exists === false && actual.found) return false;
  }
  if (!actual.found && Object.keys(expected).some((key) => key !== "exists")) return false;
  const value = actual.value;
  if ("in" in expected && !(expected.in as unknown[]).some((item) => equals(item, value))) return false;
  if ("not_in" in expected && (expected.not_in as unknown[]).some((item) => equals(item, value))) return false;
  if ("glob" in expected) {
    if (typeof value !== "string") return false;
    if (!globMatch(expected.glob as string, value)) return false;
  }
  if (typeof value === "number") {
    if ("gt" in expected && !(value > (expected.gt as number))) return false;
    if ("gte" in expected && !(value >= (expected.gte as number))) return false;
    if ("lt" in expected && !(value < (expected.lt as number))) return false;
    if ("lte" in expected && !(value <= (expected.lte as number))) return false;
    if ("between" in expected) {
      const [low, high] = expected.between as [number, number];
      if (value < low || value > high) return false;
    }
    if ("not_between" in expected) {
      const [low, high] = expected.not_between as [number, number];
      if (value >= low && value <= high) return false;
    }
  } else if (["gt", "gte", "lt", "lte", "between", "not_between"].some((op) => op in expected)) {
    return false;
  }
  return true;
}

function isOperator(expected: unknown): expected is Record<string, unknown> {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return keys.length > 0 && keys.every((key) =>
    ["in", "not_in", "gt", "gte", "lt", "lte", "between", "not_between", "glob", "exists"].includes(key),
  );
}

export function matches(match: Record<string, unknown>, ctx: EvalContext): boolean {
  for (const [key, expected] of Object.entries(match)) {
    const actual = resolvePath(ctx, key);
    if (isOperator(expected)) {
      if (!matchOperator(actual, expected)) return false;
      continue;
    }
    if (!actual.found || !equals(actual.value, expected)) return false;
  }
  return true;
}

export function ruleMatches(rule: PolicyRule, ctx: EvalContext): boolean {
  return matches(rule.match, ctx);
}
