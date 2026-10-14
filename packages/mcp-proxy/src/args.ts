import { LedgerError } from "@actledger/core";

export interface CliArgs {
  help: boolean;
  ledger?: string;
  upstream?: string;
  /** Present when the caller passed `--`, even if the command is empty. */
  command?: string[];
  upstreamCwd?: string;
  config?: string;
  principal?: string;
  name?: string;
  approvalWait?: number;
}

export function splitCommand(input: string): string[] {
  const args: string[] = [];
  let buf = "";
  let quoting: "'" | '"' | null = null;
  let started = false;
  const push = () => {
    if (!started) return;
    args.push(buf);
    buf = "";
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (quoting) {
      if (ch === "\\") {
        const next = input[i + 1];
        if (next === undefined) throw new LedgerError("invalid_request", "trailing escape in command", 400);
        buf += next;
        i += 1;
        continue;
      }
      if (ch === quoting) {
        quoting = null;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) throw new LedgerError("invalid_request", "trailing escape in command", 400);
      buf += next;
      started = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoting = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    buf += ch;
    started = true;
  }
  if (quoting) throw new LedgerError("invalid_request", "unterminated quote in command", 400);
  push();
  return args;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      out.command = argv.slice(i + 1);
      break;
    }
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new LedgerError("invalid_request", `missing value for ${arg}`, 400);
      return value;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--ledger") out.ledger = next();
    else if (arg === "--upstream") out.upstream = next();
    else if (arg === "--upstream-cwd") out.upstreamCwd = next();
    else if (arg === "--config") out.config = next();
    else if (arg === "--principal") out.principal = next();
    else if (arg === "--name") out.name = next();
    else if (arg === "--approval-wait") {
      const raw = next();
      if (!/^-?\d+$/.test(raw)) {
        throw new LedgerError("invalid_request", "approval-wait must be an integer", 400);
      }
      out.approvalWait = Number(raw);
    } else if (arg.startsWith("-")) throw new LedgerError("invalid_request", `unknown flag ${arg}`, 400);
    else throw new LedgerError("invalid_request", `unexpected argument ${arg}`, 400);
  }
  if (out.upstream !== undefined && out.command !== undefined) {
    throw new LedgerError("invalid_request", "--upstream and -- command cannot both be set", 400);
  }
  return out;
}
