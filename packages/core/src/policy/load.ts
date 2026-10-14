import { parse } from "yaml";
import { LedgerError } from "../errors.js";
import { policyDocumentSchema, resolveDefaults, validatePolicy, type LoadedPolicy } from "./schema.js";

export type { LoadedPolicy };

export function loadPolicy(yamlText: string): LoadedPolicy {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "yaml parse failed";
    throw new LedgerError("policy_invalid", message, 422);
  }
  const parsed = policyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "$";
    throw new LedgerError("policy_invalid", `${where}: ${issue?.message ?? "invalid policy"}`, 422);
  }
  const warnings = validatePolicy(parsed.data);
  return {
    doc: parsed.data,
    defaults: resolveDefaults(parsed.data),
    warnings,
  };
}
