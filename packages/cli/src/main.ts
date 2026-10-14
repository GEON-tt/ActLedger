#!/usr/bin/env node
import { isUserAssurance, LedgerError } from "@actledger/core";
import { approveCommand, rejectCommand } from "./commands/approve.js";
import { devCommand, tasksCommand } from "./commands/dev.js";
import { exportCommand, showCommand, verifyCommand } from "./commands/export.js";
import { initCommand } from "./commands/init.js";
import { rpcCommand } from "./commands/rpc.js";
import { serveCommand } from "./commands/serve.js";

interface Flags {
  dir: string;
  json: boolean;
  once: boolean;
  stepUp: boolean;
  policy?: string;
  state?: string;
  assurance: "app_asserted" | "channel_verified" | "user_signed";
  edit?: string;
  note?: string;
  secrets?: string;
  keys?: string;
  from?: number;
  to?: number;
  port?: number;
  approver?: string;
  positionals: string[];
}

function parse(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {
    dir: ".actledger",
    json: false,
    once: false,
    stepUp: false,
    assurance: "app_asserted",
    positionals: [],
  };
  const command = argv[0] ?? "help";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new LedgerError("invalid_request", `missing value for ${arg}`, 400);
      return value;
    };
    if (arg === "--dir") flags.dir = next();
    else if (arg === "--json") flags.json = true;
    else if (arg === "--once") flags.once = true;
    else if (arg === "--step-up") flags.stepUp = true;
    else if (arg === "--policy") flags.policy = next();
    else if (arg === "--state") flags.state = next();
    else if (arg === "--assurance") {
      const value = next();
      if (!isUserAssurance(value)) {
        throw new LedgerError("invalid_request", `unknown assurance ${value}`, 400);
      }
      flags.assurance = value;
    }
    else if (arg === "--edit") flags.edit = next();
    else if (arg === "--note" || arg === "--reason") flags.note = next();
    else if (arg === "--secrets") flags.secrets = next();
    else if (arg === "--keys") flags.keys = next();
    else if (arg === "--from") flags.from = Number(next());
    else if (arg === "--to") flags.to = Number(next());
    else if (arg === "--port") {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new LedgerError("invalid_request", "--port must be an integer 1-65535", 400);
      }
      flags.port = value;
    }
    else if (arg === "--approver") {
      const value = next();
      if (!value) throw new LedgerError("invalid_request", "--approver requires a principal", 400);
      flags.approver = value;
    }
    else if (arg === "--help" || arg === "-h") flags.positionals.push("help");
    else if (arg.startsWith("-")) throw new LedgerError("invalid_request", `unknown flag ${arg}`, 400);
    else flags.positionals.push(arg);
  }
  return { command, flags };
}

function help(): void {
  process.stdout.write(`actledger — local agent action ledger

  actledger init [--dir .actledger] [--policy file.yaml]
  actledger dev [--dir] [--once]
  actledger tasks [--dir] [--state] [--json]
  actledger approve <task> [--assurance app_asserted|channel_verified|user_signed] [--edit file] [--step-up]
  actledger reject <task> [--note text]  (--reason is an alias of --note)
  actledger export [--from n] [--to n] [--secrets file]
  actledger verify <receipts.jsonl> --keys <keys.json> [--secrets file] [--json]
  actledger show <receipt>
  actledger rpc [--dir .actledger]   JSON lines on stdin/stdout (used by the Python SDK)
  actledger serve [--dir .actledger] [--port 4319] [--approver <principal>]
                    local approval page on 127.0.0.1 and webhook notifier

Local mode records approvals you make in this CLI. An assurance above
app_asserted, or --step-up, is marked simulated: this CLI does not check
a real channel identity or collect a WebAuthn assertion.
`);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") argv[0] = "help";
  const { command, flags } = parse(argv);
  if (command === "help" || flags.positionals.includes("help")) {
    help();
    return;
  }
  if (command === "init") {
    initCommand({ dir: flags.dir, policy: flags.policy });
    return;
  }
  if (command === "dev") {
    devCommand({ dir: flags.dir, once: flags.once });
    return;
  }
  if (command === "tasks") {
    tasksCommand({ dir: flags.dir, state: flags.state, json: flags.json });
    return;
  }
  if (command === "approve") {
    const id = flags.positionals[0];
    if (!id) throw new LedgerError("invalid_request", "approve requires a task id", 400);
    approveCommand({
      dir: flags.dir,
      id,
      assurance: flags.assurance,
      edit: flags.edit,
      stepUp: flags.stepUp,
      json: flags.json,
    });
    return;
  }
  if (command === "reject") {
    const id = flags.positionals[0];
    if (!id) throw new LedgerError("invalid_request", "reject requires a task id", 400);
    rejectCommand({ dir: flags.dir, id, note: flags.note });
    return;
  }
  if (command === "export") {
    exportCommand({ dir: flags.dir, from: flags.from, to: flags.to, secrets: flags.secrets });
    return;
  }
  if (command === "verify") {
    const file = flags.positionals[0];
    if (!file || !flags.keys) throw new LedgerError("invalid_request", "verify requires a file and --keys", 400);
    process.exitCode = verifyCommand({ file, keys: flags.keys, secrets: flags.secrets, json: flags.json });
    return;
  }
  if (command === "show") {
    const id = flags.positionals[0];
    if (!id) throw new LedgerError("invalid_request", "show requires a receipt id", 400);
    showCommand({ dir: flags.dir, id });
    return;
  }
  if (command === "rpc") {
    rpcCommand({ dir: flags.dir });
    return;
  }
  if (command === "serve") {
    serveCommand({ dir: flags.dir, port: flags.port ?? 4319, approver: flags.approver }).catch(handleError);
    return;
  }
  throw new LedgerError("invalid_request", `unknown command ${command}`, 400);
}

function handleError(error: unknown): never {
  if (error instanceof LedgerError) {
    process.stderr.write(`error: ${error.code}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

try {
  main();
} catch (error) {
  handleError(error);
}
