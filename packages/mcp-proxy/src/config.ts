import fs from "node:fs";
import path from "node:path";
import { assertDriftPath, LedgerError } from "@actledger/core";
import { parse } from "yaml";
import { z } from "zod";
import { type CliArgs, splitCommand } from "./args.js";
import { isReservedAttrKey, type ToolMapping } from "./payload.js";

const toolMappingSchema = z.object({
  action: z.string().min(1),
  content: z
    .object({
      field: z.string().min(1),
      content_type: z.string().min(1),
    })
    .optional(),
  attrs_from: z
    .record(z.string(), z.string())
    .superRefine((attrs, ctx) => {
      for (const key of Object.keys(attrs)) {
        if (isReservedAttrKey(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cannot use reserved key ${key}` });
        }
      }
    })
    .optional(),
  allowed_drift: z.array(z.string()).optional(),
});

export const proxyConfigSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).optional(),
  ledger: z.string().min(1).optional(),
  principal: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  upstream: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().min(1).optional(),
      env_passthrough: z.array(z.string()).optional(),
    })
    .optional(),
  approval: z
    .object({
      wait_ms: z.number().optional(),
    })
    .optional(),
  check_task_tool: z.string().min(1).optional(),
  unmapped: z.enum(["tool_name", "hide"]).optional(),
  tools: z.record(z.string(), toolMappingSchema).optional(),
});

export interface ProxyConfig {
  version: 1;
  name?: string;
  ledger?: string;
  principal?: string;
  agentId?: string;
  upstream?: {
    command: string;
    args: string[];
    cwd?: string;
    envPassthrough: string[];
  };
  approvalWaitMs?: number;
  checkTaskTool?: string;
  unmapped?: "tool_name" | "hide";
  tools: Record<string, ToolMapping>;
}

export interface ResolvedConfig {
  name: string;
  ledger: string;
  principal: string;
  agentId: string;
  upstream: {
    command: string;
    args: string[];
    cwd: string;
    envPassthrough: string[];
  };
  approval: { waitMs: number };
  checkTaskTool: string;
  unmapped: "tool_name" | "hide";
  tools: Record<string, ToolMapping>;
}

function fail(file: string, message: string): never {
  throw new LedgerError("invalid_request", `${file}: ${message}`, 400);
}

export function loadProxyConfig(file: string): ProxyConfig {
  const abs = path.resolve(file);
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(abs, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable config";
    fail(abs, message);
  }
  const parsed = proxyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "$";
    fail(abs, `${where}: ${issue?.message ?? "invalid config"}`);
  }
  const dir = path.dirname(abs);
  const data = parsed.data;
  const tools: Record<string, ToolMapping> = {};
  for (const [name, mapping] of Object.entries(data.tools ?? {})) {
    tools[name] = {
      action: mapping.action,
      ...(mapping.content ? { content: mapping.content } : {}),
      ...(mapping.attrs_from ? { attrsFrom: mapping.attrs_from } : {}),
      ...(mapping.allowed_drift ? { allowedDrift: mapping.allowed_drift } : {}),
    };
  }
  return {
    version: 1,
    name: data.name,
    ledger: data.ledger ? path.resolve(dir, data.ledger) : undefined,
    principal: data.principal,
    agentId: data.agent_id,
    upstream: data.upstream
      ? {
          command: data.upstream.command,
          args: data.upstream.args ?? [],
          cwd: data.upstream.cwd ? path.resolve(dir, data.upstream.cwd) : undefined,
          envPassthrough: data.upstream.env_passthrough ?? [],
        }
      : undefined,
    approvalWaitMs: data.approval?.wait_ms,
    checkTaskTool: data.check_task_tool,
    unmapped: data.unmapped,
    tools,
  };
}

export function resolveConfig(cli: CliArgs, file?: ProxyConfig): ResolvedConfig {
  const name = cli.name ?? file?.name ?? "upstream";
  const ledger = cli.ledger ? path.resolve(cli.ledger) : file?.ledger;
  if (!ledger) throw new LedgerError("invalid_request", "ledger is required", 400);

  let command: string;
  let args: string[];
  if (cli.command !== undefined) {
    if (cli.command.length === 0) throw new LedgerError("invalid_request", "upstream command is required", 400);
    command = cli.command[0] ?? "";
    args = cli.command.slice(1);
  } else if (cli.upstream !== undefined) {
    const parts = splitCommand(cli.upstream);
    if (parts.length === 0) throw new LedgerError("invalid_request", "upstream command is required", 400);
    command = parts[0] ?? "";
    args = parts.slice(1);
  } else if (file?.upstream) {
    command = file.upstream.command;
    args = file.upstream.args;
  } else {
    throw new LedgerError("invalid_request", "upstream command is required", 400);
  }
  if (!command) throw new LedgerError("invalid_request", "upstream command is required", 400);

  const waitMs = cli.approvalWait ?? file?.approvalWaitMs ?? 3000;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
    throw new LedgerError("invalid_request", "approval.wait_ms must be an integer from 0 to 30000", 400);
  }

  const tools = file?.tools ?? {};
  for (const [toolName, mapping] of Object.entries(tools)) {
    for (const key of Object.keys(mapping.attrsFrom ?? {})) {
      if (isReservedAttrKey(key)) {
        throw new LedgerError("invalid_request", `tools.${toolName}.attrs_from cannot use reserved key ${key}`, 400);
      }
    }
    for (const drift of mapping.allowedDrift ?? []) assertDriftPath(drift);
  }

  return {
    name,
    ledger,
    principal: cli.principal ?? file?.principal ?? "local-user",
    agentId: file?.agentId ?? `mcp-proxy:${name}`,
    upstream: {
      command,
      args,
      cwd: cli.upstreamCwd ? path.resolve(cli.upstreamCwd) : file?.upstream?.cwd ?? process.cwd(),
      envPassthrough: file?.upstream?.envPassthrough ?? [],
    },
    approval: { waitMs },
    checkTaskTool: file?.checkTaskTool ?? "check_task",
    unmapped: file?.unmapped ?? "tool_name",
    tools,
  };
}
