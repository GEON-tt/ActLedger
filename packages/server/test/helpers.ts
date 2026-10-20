import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../src/store.js";
import { hashPassword } from "../src/password.js";
import { newTotpSecret } from "../src/totp.js";
import { initServerData, serverDbPath } from "../src/data.js";
import { startServer, type ServerHandle, type ServerOptions } from "../src/server.js";

export const openPolicy = `
version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
  db.delete: { level: delete }
`;

const dirs: string[] = [];
const handles: ServerHandle[] = [];

export function tempData(policyYaml = openPolicy): string {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "actl-server-"));
  dirs.push(data);
  initServerData(data, { policyYaml });
  return data;
}

export async function addUser(
  data: string,
  username: string,
  principalId: string,
  password = "correct horse battery",
): Promise<{ secret: string; password: string }> {
  const secret = newTotpSecret();
  const passwordHash = await hashPassword(password);
  const store = CredentialStore.open(serverDbPath(data));
  try {
    store.addUser({ username, principalId, passwordHash, totpSecret: secret });
  } finally {
    store.close();
  }
  return { secret, password };
}

export function agentKey(data: string, agentId: string, principals: string[]): string {
  const store = CredentialStore.open(serverDbPath(data));
  try {
    return store.createKey({ kind: "agent", agentId, principalIds: principals }).key;
  } finally {
    store.close();
  }
}

export function auditKey(data: string): string {
  const store = CredentialStore.open(serverDbPath(data));
  try {
    return store.createKey({ kind: "audit" }).key;
  } finally {
    store.close();
  }
}

export async function boot(
  data: string,
  opts?: Partial<ServerOptions>,
): Promise<{ handle: ServerHandle; clock: { now: Date } }> {
  const clock = { now: new Date("2026-01-05T00:00:00.000Z") };
  const handle = await startServer({
    data,
    port: 0,
    sweepMs: 0,
    now: () => clock.now,
    ...opts,
  });
  handles.push(handle);
  return { handle, clock };
}

export function track(handle: ServerHandle): void {
  handles.push(handle);
}

export function request(
  port: number,
  method: string,
  requestPath: string,
  opts?: { headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: requestPath, headers: opts?.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(opts?.body);
  });
}

export async function api(
  port: number,
  method: string,
  requestPath: string,
  key: string | null,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  const merged: Record<string, string> = { ...headers };
  if (key) merged.authorization = `Bearer ${key}`;
  let payload: string | undefined;
  if (body !== undefined) {
    if (!merged["content-type"] && !merged["Content-Type"]) merged["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await request(port, method, requestPath, { headers: merged, body: payload });
  let json: any = null;
  if (res.body) {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = res.body;
    }
  }
  return { status: res.status, json, headers: res.headers };
}

export function form(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  return params.toString();
}

export function field(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

export async function login(
  port: number,
  username: string,
  password: string,
  code: string,
  headers?: Record<string, string>,
): Promise<{ status: number; cookie: string | null; headers: http.IncomingHttpHeaders; body: string }> {
  const res = await request(port, "POST", "/login", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: `http://127.0.0.1:${port}`,
      ...headers,
    },
    body: form({ username, password, totp: code }),
  });
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
  const match = /actledger_session=([^;]+)/.exec(joined);
  return { status: res.status, cookie: match ? `actledger_session=${match[1]}` : null, headers: res.headers, body: res.body };
}

export async function csrfFrom(port: number, cookie: string, requestPath: string): Promise<string> {
  const res = await request(port, "GET", requestPath, { headers: { cookie } });
  return field(res.body, "csrf");
}

export async function cleanup(): Promise<void> {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
