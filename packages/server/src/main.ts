#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { LedgerError } from "@actledger/core";
import { assertInitialized, initServerData, resolveDataDir, serverDbPath } from "./data.js";
import { checkPasswordPolicy, hashPassword } from "./password.js";
import { readHidden } from "./prompt.js";
import { renderQr } from "./qr.js";
import { startServer } from "./server.js";
import { CredentialStore, type KeyRow, type UserRow } from "./store.js";
import { newTotpSecret, otpauthUrl } from "./totp.js";

const HELP = `actledger-server init [--data dir] [--policy file.yaml]
actledger-server serve [--data dir] [--host 127.0.0.1] [--port 4400] [--trust-proxy] [--public-url url] [--sweep-ms 5000]
actledger-server user add <username> --principal <id> [--data dir] [--password-stdin] [--no-qr] [--json]
actledger-server user reset-totp <username> [--data dir] [--no-qr] [--json]
actledger-server user list [--data dir] [--json]
actledger-server agent-key create --agent <id> --principal <id> [--principal <id> ...] [--label text] [--data dir] [--json]
actledger-server agent-key revoke <key id> [--data dir]
actledger-server agent-key list [--data dir] [--json]
actledger-server audit-key create [--label text] [--data dir] [--json]
actledger-server audit-key revoke <key id> [--data dir]
actledger-server help
`;

interface Values {
  data?: string;
  policy?: string;
  host?: string;
  port?: string;
  trustProxy: boolean;
  publicUrl?: string;
  sweepMs?: string;
  principal: string[];
  agent?: string;
  label?: string;
  passwordStdin: boolean;
  noQr: boolean;
  json: boolean;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      policy: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "trust-proxy": { type: "boolean" },
      "public-url": { type: "string" },
      "sweep-ms": { type: "string" },
      principal: { type: "string", multiple: true },
      agent: { type: "string" },
      label: { type: "string" },
      "password-stdin": { type: "boolean" },
      "no-qr": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const values: Values = {
    data: parsed.values.data,
    policy: parsed.values.policy,
    host: parsed.values.host,
    port: parsed.values.port,
    trustProxy: parsed.values["trust-proxy"] === true,
    publicUrl: parsed.values["public-url"],
    sweepMs: parsed.values["sweep-ms"],
    principal: parsed.values.principal ?? [],
    agent: parsed.values.agent,
    label: parsed.values.label,
    passwordStdin: parsed.values["password-stdin"] === true,
    noQr: parsed.values["no-qr"] === true,
    json: parsed.values.json === true,
  };
  const [group, action, positional, extra] = parsed.positionals;
  const data = resolveDataDir(values.data);
  if (!group || group === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (group === "init") {
    if (action !== undefined) throw new LedgerError("invalid_request", "init takes no arguments", 400);
    const policyYaml = values.policy ? fs.readFileSync(values.policy, "utf8") : undefined;
    const created = initServerData(data, policyYaml ? { policyYaml } : undefined);
    process.stdout.write(`initialized ${created.data}\napp ${created.appId}\n`);
    process.stdout.write(
      `next: actledger-server user add <username> --principal <id> --data ${created.data}\n`,
    );
    for (const warning of created.warnings) process.stderr.write(`warning: ${warning.message}\n`);
    return;
  }
  if (group === "serve") {
    if (action !== undefined) throw new LedgerError("invalid_request", "serve takes no arguments", 400);
    await serve(values, data);
    return;
  }
  if (group === "user" && action === "add") {
    if (!positional || extra !== undefined) throw new LedgerError("invalid_request", "user add requires a username", 400);
    if (values.principal.length !== 1) throw new LedgerError("invalid_request", "user add requires one --principal", 400);
    await addUser(data, positional, values.principal[0] ?? "", values);
    return;
  }
  if (group === "user" && action === "reset-totp") {
    if (!positional || extra !== undefined) throw new LedgerError("invalid_request", "user reset-totp requires a username", 400);
    await resetTotp(data, positional, values);
    return;
  }
  if (group === "user" && action === "list") {
    if (positional !== undefined) throw new LedgerError("invalid_request", "user list takes no arguments", 400);
    await withStore(data, (store) => {
      const users = store.listUsers();
      if (values.json) {
        writeJson({
          users: users.map((user) => ({
            username: user.username,
            principalId: user.principalId,
            locked: isLocked(user, new Date()),
            createdAt: user.createdAt,
          })),
        });
        return;
      }
      for (const user of users) {
        process.stdout.write(
          `${user.username}  ${user.principalId}  locked=${isLocked(user, new Date()) ? "yes" : "no"}  created=${user.createdAt}\n`,
        );
      }
    });
    return;
  }
  if (group === "agent-key" && action === "create") {
    if (positional !== undefined) throw new LedgerError("invalid_request", "agent-key create takes no arguments", 400);
    if (!values.agent) throw new LedgerError("invalid_request", "agent-key create requires --agent", 400);
    if (values.principal.length === 0) throw new LedgerError("invalid_request", "agent-key create requires --principal", 400);
    await withStore(data, (store) => {
      const created = store.createKey({
        kind: "agent",
        agentId: values.agent ?? "",
        principalIds: values.principal,
        ...(values.label !== undefined ? { label: values.label } : {}),
      });
      if (values.json) {
        writeJson({
          id: created.row.id,
          kind: "agent",
          agentId: created.row.agentId,
          principalIds: created.row.principalIds,
          key: created.key,
        });
        return;
      }
      process.stdout.write(
        `key ${created.row.id} for agent ${created.row.agentId}, principals ${created.row.principalIds.join(",")}\n`,
      );
      process.stdout.write(`${created.key}\n`);
      process.stdout.write("This is the only time the key is shown. Set it as ACTLEDGER_API_KEY on the agent machine.\n");
    });
    return;
  }
  if (group === "agent-key" && action === "revoke") {
    if (!positional || extra !== undefined) throw new LedgerError("invalid_request", "agent-key revoke requires a key id", 400);
    await withStore(data, (store) => {
      store.revokeKey(positional, "agent");
      process.stdout.write(`revoked ${positional}\n`);
    });
    return;
  }
  if (group === "agent-key" && action === "list") {
    if (positional !== undefined) throw new LedgerError("invalid_request", "agent-key list takes no arguments", 400);
    await withStore(data, (store) => printKeys(store.listKeys("agent"), values.json));
    return;
  }
  if (group === "audit-key" && action === "create") {
    if (positional !== undefined) throw new LedgerError("invalid_request", "audit-key create takes no arguments", 400);
    await withStore(data, (store) => {
      const created = store.createKey({
        kind: "audit",
        ...(values.label !== undefined ? { label: values.label } : {}),
      });
      if (values.json) {
        writeJson({ id: created.row.id, kind: "audit", key: created.key });
        return;
      }
      process.stdout.write(`audit key ${created.row.id}\n`);
      process.stdout.write(`${created.key}\n`);
      process.stdout.write("This is the only time the key is shown. Use it as a bearer token for GET /v1/export.\n");
    });
    return;
  }
  if (group === "audit-key" && action === "revoke") {
    if (!positional || extra !== undefined) throw new LedgerError("invalid_request", "audit-key revoke requires a key id", 400);
    await withStore(data, (store) => {
      store.revokeKey(positional, "audit");
      process.stdout.write(`revoked ${positional}\n`);
    });
    return;
  }
  throw new LedgerError("invalid_request", `unknown command ${parsed.positionals.join(" ")}`, 400);
}

async function serve(values: Values, data: string): Promise<void> {
  const port = parseInteger(values.port, "--port", 0, 65535);
  const sweepMs = parseInteger(values.sweepMs, "--sweep-ms", 0, 2_147_483_647);
  const host = values.host ?? "127.0.0.1";
  const handle = await startServer({
    data,
    host,
    ...(port !== undefined ? { port } : {}),
    trustProxy: values.trustProxy,
    ...(values.publicUrl !== undefined ? { publicUrl: values.publicUrl } : {}),
    ...(sweepMs !== undefined ? { sweepMs } : {}),
  });
  process.stderr.write(`actledger-server listening on http://${host}:${handle.port}\n`);
  process.stderr.write(`public url: ${handle.publicUrl}\n`);
  if (!values.trustProxy && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    process.stderr.write(
      `warning: serving plain HTTP on ${host}; put an HTTPS reverse proxy in front and pass --trust-proxy\n`,
    );
  }
  const shutdown = (): void => {
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function addUser(data: string, username: string, principalId: string, values: Values): Promise<void> {
  const password = await readPassword(values.passwordStdin);
  checkPasswordPolicy(password);
  const passwordHash = await hashPassword(password);
  const secret = newTotpSecret();
  await withStore(data, (store) => {
    const user = store.addUser({ username, principalId, passwordHash, totpSecret: secret });
    writeEnrollment(user, secret, values, `user ${user.username} added for principal ${user.principalId}`);
  });
}

async function resetTotp(data: string, username: string, values: Values): Promise<void> {
  const secret = newTotpSecret();
  await withStore(data, (store) => {
    const user = store.resetTotp(username, secret);
    writeEnrollment(user, secret, values, `new authenticator secret for ${user.username}; existing sessions are signed out`);
  });
}

function writeEnrollment(user: UserRow, secret: string, values: Values, firstLine: string): void {
  const url = otpauthUrl({ secret, username: user.username });
  if (values.json) {
    writeJson({ userId: user.id, username: user.username, principalId: user.principalId, otpauthUrl: url, secret });
    return;
  }
  process.stdout.write(`${firstLine}\n`);
  process.stdout.write("Add this account to an authenticator app. Scan the QR code or enter the secret.\n");
  if (!values.noQr) {
    const qr = renderQr(url);
    if (qr) process.stdout.write(qr.endsWith("\n") ? qr : `${qr}\n`);
  }
  process.stdout.write(`${url}\n`);
  process.stdout.write(`secret: ${secret.replace(/(.{4})/g, "$1 ").trim()}\n`);
}

function printKeys(keys: KeyRow[], json: boolean): void {
  if (json) {
    writeJson({ keys });
    return;
  }
  for (const key of keys) {
    process.stdout.write(
      `${key.id}  ${key.agentId ?? ""}  ${key.principalIds.join(",")}  created=${key.createdAt}  revoked=${key.revokedAt ?? "-"}  last_used=${key.lastUsedAt ?? "-"}\n`,
    );
  }
}

function isLocked(user: UserRow, now: Date): boolean {
  return user.lockedUntil !== null && Date.parse(user.lockedUntil) > now.getTime();
}

async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let text = Buffer.concat(chunks).toString("utf8");
    if (text.endsWith("\r\n")) text = text.slice(0, -2);
    else if (text.endsWith("\n")) text = text.slice(0, -1);
    return text;
  }
  if (!process.stdin.isTTY) throw new LedgerError("invalid_request", "no terminal; pass --password-stdin", 400);
  const first = await readHidden("Password: ");
  const second = await readHidden("Repeat password: ");
  if (first !== second) throw new LedgerError("invalid_request", "passwords do not match", 400);
  return first;
}

async function withStore<T>(data: string, fn: (store: CredentialStore) => Promise<T> | T): Promise<T> {
  assertInitialized(data);
  const store = CredentialStore.open(serverDbPath(data));
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function parseInteger(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new LedgerError("invalid_request", `${flag} must be an integer`, 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new LedgerError("invalid_request", `${flag} must be an integer`, 400);
  }
  return parsed;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handleError(error: unknown): never {
  if (error instanceof LedgerError) {
    process.stderr.write(`error: ${error.code}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

main().catch(handleError);
