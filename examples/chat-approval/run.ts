import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initLocalDir } from "@actledger/core";
import { startServer, type ServeHandle } from "@actledger/cli/serve";
import { Ledger } from "@actledger/sdk";
import { startChatServer, type ChatServerHandle } from "./chat-server.js";
import { loadProvider, resolveProviderName } from "./providers/index.js";
import type { Provider, ProviderName } from "./providers/types.js";
import { createNoteTools } from "./tools.js";

export const DEFAULT_SERVE_PORT = 4328;
export const DEFAULT_CHAT_PORT = 4340;
export const EXAMPLE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface DemoOptions {
  /** 默认 <EXAMPLE_DIR>/out。账本在 <dataDir>/ledger，outbox 在 <dataDir>/outbox.jsonl。 */
  dataDir?: string;
  /** 默认 ACTLEDGER_DEMO_SERVE_PORT，再默认 4328。测试传 0。 */
  servePort?: number;
  /** 默认 ACTLEDGER_DEMO_CHAT_PORT，再默认 4340。测试传 0。 */
  chatPort?: number;
  /** 不传时由 resolveProviderName(env) 决定。 */
  provider?: ProviderName;
  /** 默认 process.env。测试传 {}，这样开发机上的 key 不影响测试。 */
  env?: NodeJS.ProcessEnv;
  /** 默认写 stdout。 */
  log?: (line: string) => void;
  /** 默认 15 * 60_000。 */
  gateTimeoutMs?: number;
  /** 默认 250。 */
  gatePollMs?: number;
  /** true：启动前删掉 dataDir。默认 env.ACTLEDGER_DEMO_FRESH === "1"。 */
  fresh?: boolean;
}

export interface DemoHandle {
  serve: ServeHandle;
  chat: ChatServerHandle;
  provider: ProviderName;
  ledgerDir: string;
  outbox: string;
  close(): Promise<void>;
}

function portFromEnv(explicit: number | undefined, raw: string | undefined, envName: string, fallback: number): number {
  if (explicit !== undefined) return explicit;
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error(`invalid ${envName}`);
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`invalid ${envName}`);
  return value;
}

interface Started {
  chat?: ChatServerHandle;
  provider?: Provider;
  ledger?: Ledger;
  serve?: ServeHandle;
}

async function shutdown(started: Started): Promise<void> {
  const errors: unknown[] = [];
  const step = async (fn: (() => Promise<void> | void) | undefined) => {
    if (!fn) return;
    try {
      await fn();
    } catch (error) {
      errors.push(error);
    }
  };
  await step(started.chat ? () => started.chat?.close() : undefined);
  await step(started.provider ? () => started.provider?.close() : undefined);
  await step(started.ledger ? () => started.ledger?.close() : undefined);
  await step(started.serve ? () => started.serve?.close() : undefined);
  if (errors.length > 0) throw errors[0];
}

export async function startDemo(opts: DemoOptions = {}): Promise<DemoHandle> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dataDir = path.resolve(opts.dataDir ?? path.join(EXAMPLE_DIR, "out"));
  const fresh = opts.fresh ?? env.ACTLEDGER_DEMO_FRESH === "1";
  if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });
  const ledgerDir = path.join(dataDir, "ledger");
  const outbox = path.join(dataDir, "outbox.jsonl");
  fs.mkdirSync(dataDir, { recursive: true });

  const policyYaml = fs.readFileSync(path.join(EXAMPLE_DIR, "policy.yaml"), "utf8");
  if (!fs.existsSync(path.join(ledgerDir, "app.json"))) {
    initLocalDir(ledgerDir, { policyYaml });
  } else {
    const dest = path.join(ledgerDir, "policy.yaml");
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
    if (current !== policyYaml) fs.writeFileSync(dest, policyYaml);
  }

  const servePort = portFromEnv(opts.servePort, env.ACTLEDGER_DEMO_SERVE_PORT, "ACTLEDGER_DEMO_SERVE_PORT", DEFAULT_SERVE_PORT);
  const chatPort = portFromEnv(opts.chatPort, env.ACTLEDGER_DEMO_CHAT_PORT, "ACTLEDGER_DEMO_CHAT_PORT", DEFAULT_CHAT_PORT);
  const gateTimeoutMs = opts.gateTimeoutMs ?? 15 * 60_000;
  const gatePollMs = opts.gatePollMs ?? 250;
  const name = opts.provider ?? resolveProviderName(env).name;
  const provider = await loadProvider(name, env);

  const started: Started = { provider };
  try {
    started.serve = await startServer({
      dir: ledgerDir,
      port: servePort,
      pollMs: 0,
      env,
      log: (line) => log(`[serve] ${line}`),
    });
    started.ledger = new Ledger({ mode: "local", dir: ledgerDir });
    const tools = createNoteTools({ ledger: started.ledger, outbox, timeoutMs: gateTimeoutMs, pollMs: gatePollMs });
    started.chat = await startChatServer({
      port: chatPort,
      ledgerDir,
      serveOrigin: started.serve.origin,
      provider,
      tools,
      log,
    });
  } catch (error) {
    try {
      await shutdown(started);
    } catch {
      // The original startup error is the one the caller needs.
    }
    throw error;
  }

  const serve = started.serve;
  const chat = started.chat;
  const ledger = started.ledger;
  if (!serve || !chat || !ledger) throw new Error("demo did not start");

  let closing: Promise<void> | undefined;
  return {
    serve,
    chat,
    provider: name,
    ledgerDir,
    outbox,
    close() {
      closing ??= shutdown({ chat, provider, ledger, serve });
      return closing;
    },
  };
}

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URLs are already printed.
  }
}

function portInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("is in use")) return true;
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}

async function main(): Promise<void> {
  try {
    loadEnvFile(path.join(EXAMPLE_DIR, ".env"));
    const { name, suggestion } = resolveProviderName(process.env);
    const handle = await startDemo({ provider: name });
    process.stdout.write(`approval console: ${handle.serve.origin}/   login: ${handle.serve.loginUrl}\n`);
    process.stdout.write(`chat:             ${handle.chat.origin}/\n`);
    process.stdout.write(`provider:         ${handle.provider}\n`);
    if (suggestion) process.stdout.write(`${suggestion}\n`);
    if (process.env.ACTLEDGER_DEMO_NO_OPEN !== "1") {
      openBrowser(handle.serve.loginUrl);
      setTimeout(() => openBrowser(`${handle.chat.origin}/`), 300);
    }
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void stop();
    });
    process.on("SIGTERM", () => {
      void stop();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    if (portInUse(error)) {
      process.stderr.write("set ACTLEDGER_DEMO_SERVE_PORT / ACTLEDGER_DEMO_CHAT_PORT\n");
    }
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void main();
}
