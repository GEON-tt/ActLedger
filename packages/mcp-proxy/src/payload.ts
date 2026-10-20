import { jcs, normalizePayload, sha256Hex, type Payload, type RequestInput } from "@actledger/core";
import type { ResolvedConfig } from "./config.js";

export interface ToolMapping {
  action: string;
  content?: { field: string; content_type: string };
  attrsFrom?: Record<string, string>;
  allowedDrift?: string[];
}

export function isReservedAttrKey(key: string): boolean {
  return key === "mcp_server" || key === "mcp_tool";
}

export function canExecuteTool(
  cfg: ResolvedConfig,
  toolName: string,
  task: { actionType: string; agentId: string | null },
  approved: Payload,
  toolNames: ReadonlySet<string>,
): boolean {
  if (task.agentId !== cfg.agentId) return false;
  if (!toolNames.has(toolName)) return false;
  if (cfg.unmapped === "hide" && !cfg.tools[toolName]) return false;
  const mapping = mappingFor(cfg, toolName);
  if (!mapping) return false;
  return mapping.action === task.actionType && mapping.action === approved.action;
}

export function mappingFor(cfg: ResolvedConfig, toolName: string): ToolMapping | null {
  const mapped = cfg.tools[toolName];
  if (mapped) return mapped;
  if (cfg.unmapped === "hide") return null;
  return { action: toolName };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function toolCallToRequest(
  cfg: ResolvedConfig,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Omit<RequestInput, "idempotencyKey"> {
  const mapping = mappingFor(cfg, toolName) ?? { action: toolName };
  const source = structuredClone(args ?? {}) as Record<string, unknown>;
  const attrs: Record<string, unknown> = {
    mcp_server: cfg.name,
    mcp_tool: toolName,
  };
  for (const [attr, field] of Object.entries(mapping.attrsFrom ?? {})) {
    if (isReservedAttrKey(attr)) continue;
    const value = source[field];
    if (isScalar(value)) attrs[attr] = value;
  }
  const payload: Payload = {
    action: mapping.action,
    args: source,
  };
  if (mapping.content) {
    const value = source[mapping.content.field];
    if (typeof value === "string") {
      delete source[mapping.content.field];
      payload.content = { content_type: mapping.content.content_type, text: value };
    }
  }
  if (mapping.allowedDrift && mapping.allowedDrift.length > 0) {
    payload.allowed_drift = mapping.allowedDrift;
  }
  normalizePayload(payload);
  return {
    principalId: cfg.principal,
    agentId: cfg.agentId,
    intent: `MCP tool call ${toolName}`,
    action: { type: mapping.action, attrs },
    payload,
  };
}

export function payloadToArguments(mapping: ToolMapping, approved: Payload): Record<string, unknown> {
  const args = structuredClone(approved.args) as Record<string, unknown>;
  if (mapping.content && typeof approved.content?.text === "string") {
    args[mapping.content.field] = approved.content.text;
  }
  return args;
}

export function fingerprint(serverName: string, toolName: string, args: Record<string, unknown>): string {
  return sha256Hex(jcs({ server: serverName, tool: toolName, args }));
}
