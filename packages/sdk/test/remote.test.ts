import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalDir } from "@actledger/core";
import {
  ContentMismatch,
  Ledger,
  LedgerError,
  LedgerUnavailable,
  RemoteTransport,
  Run,
  approveHint,
} from "../src/index.js";

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  const url = process.env.ACTLEDGER_URL;
  const key = process.env.ACTLEDGER_API_KEY;
  delete process.env.ACTLEDGER_URL;
  delete process.env.ACTLEDGER_API_KEY;
  if (url !== undefined) process.env.ACTLEDGER_URL = url;
  if (key !== undefined) process.env.ACTLEDGER_API_KEY = key;
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function listen(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{
  url: string;
  hits: Hit[];
  close: () => Promise<void>;
}> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const handle = {
        url: `http://127.0.0.1:${address.port}`,
        hits,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      };
      servers.push(handle);
      resolve(handle);
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const saved: { url?: string; key?: string } = {};

function rememberEnv(): void {
  saved.url = process.env.ACTLEDGER_URL;
  saved.key = process.env.ACTLEDGER_API_KEY;
}

function restoreEnv(): void {
  if (saved.url === undefined) delete process.env.ACTLEDGER_URL;
  else process.env.ACTLEDGER_URL = saved.url;
  if (saved.key === undefined) delete process.env.ACTLEDGER_API_KEY;
  else process.env.ACTLEDGER_API_KEY = saved.key;
}

describe("remote mode", () => {
  it("requires an explicit mode and reads url and apiKey from the environment", () => {
    rememberEnv();
    try {
      delete process.env.ACTLEDGER_URL;
      delete process.env.ACTLEDGER_API_KEY;
      expect(() => new Ledger({})).toThrow(LedgerError);
      try {
        new Ledger({});
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_request" });
        expect((error as Error).message).toBe("pass mode: 'local' or a transport");
      }
      process.env.ACTLEDGER_URL = "http://127.0.0.1:9";
      process.env.ACTLEDGER_API_KEY = "from-env";
      expect(() => new Ledger({})).toThrow(/pass mode: 'local' or a transport/);
      expect(() => new Ledger({ mode: "remote" })).not.toThrow();
      delete process.env.ACTLEDGER_URL;
      expect(() => new Ledger({ mode: "remote", apiKey: "k" })).toThrow(LedgerError);
      try {
        new Ledger({ mode: "remote", apiKey: "k" });
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid_request",
          status: 400,
          message: "remote mode needs url and apiKey (or ACTLEDGER_URL and ACTLEDGER_API_KEY)",
        });
      }
      process.env.ACTLEDGER_URL = "http://127.0.0.1:9/";
      process.env.ACTLEDGER_API_KEY = "from-env";
      const ledger = new Ledger({ mode: "remote" });
      expect(ledger.mode).toBe("remote");
      expect(ledger.consoleUrl).toBe("http://127.0.0.1:9");
      expect(ledger.dir).toBeNull();
    } finally {
      restoreEnv();
    }
  });

  it("rejects non-loopback http unless allowInsecureHttp is set, and rejects local-only options", () => {
    expect(() => new Ledger({ mode: "remote", url: "http://example.com", apiKey: "k" })).toThrow(
      /allowInsecureHttp/,
    );
    const open = new Ledger({ mode: "remote", url: "http://example.com", apiKey: "k", allowInsecureHttp: true });
    expect(open.consoleUrl).toBe("http://example.com");
    const loop = new Ledger({ mode: "remote", url: "http://127.0.0.1:9/actledger/", apiKey: "k" });
    expect(loop.consoleUrl).toBe("http://127.0.0.1:9/actledger");
    expect(() => new Ledger({ mode: "remote", url: "http://127.0.0.1:9", apiKey: "k", dir: ".actledger" })).toThrow(
      /local-only/,
    );
    expect(() =>
      new Ledger({ mode: "remote", url: "http://127.0.0.1:9", apiKey: "k", coverageOverlay: [] }),
    ).toThrow(/local-only/);
    expect(() => new Ledger({ mode: "remote", url: "http://127.0.0.1:9?x=1", apiKey: "k" })).toThrow(/query or hash/);
    const user = "alice";
    const secret = "s3cret-token";
    try {
      new Ledger({ mode: "remote", url: `https://${user}:${secret}@example.com/actledger`, apiKey: "k" });
      throw new Error("expected userinfo to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_request", message: "remote url must not include userinfo" });
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain(user);
    }
  });

  it("sends the agent API shape", async () => {
    const fake = await listen((req, body, res) => {
      if (req.method === "GET") {
        json(res, 200, { task: { id: "a/b", state: "approved" } });
        return;
      }
      json(res, 200, { ok: true, echoed: body });
    });
    const ledger = new Ledger({ mode: "remote", url: fake.url, apiKey: "secret" });
    await ledger.request({
      principalId: "u_1",
      action: { type: "email.send" },
      payload: { action: "email.send", args: { to: "a@b.c" } },
      idempotencyKey: "req-1",
    });
    const transport = new RemoteTransport({
      url: fake.url,
      apiKey: "secret",
      requestTimeoutMs: 5_000,
      allowInsecureHttp: false,
      fetch: globalThis.fetch,
    });
    await transport.getTask("a/b");
    await transport.claim("a/b", { idempotencyKey: "claim-1" });
    await transport.complete("a/b", {
      executedPayload: { action: "email.send", args: { to: "a@b.c" } },
      idempotencyKey: "done-1",
      result: { ok: true },
    });
    expect(fake.hits[0]).toMatchObject({ method: "POST", url: "/v1/tasks" });
    expect(fake.hits[0]?.headers.authorization).toBe("Bearer secret");
    expect(fake.hits[0]?.headers["content-type"]).toBe("application/json");
    expect(fake.hits[0]?.headers.accept).toBe("application/json");
    expect(JSON.parse(fake.hits[0]?.body ?? "{}")).toMatchObject({
      principalId: "u_1",
      idempotencyKey: "req-1",
      action: { type: "email.send" },
    });
    expect(fake.hits[1]?.url).toBe("/v1/tasks/a%2Fb");
    expect(fake.hits[1]?.method).toBe("GET");
    expect(fake.hits[1]?.headers["content-type"]).toBeUndefined();
    expect(JSON.parse(fake.hits[2]?.body ?? "{}")).toEqual({ idempotencyKey: "claim-1" });
    expect(fake.hits[2]?.url).toBe("/v1/tasks/a%2Fb/claim");
    expect(JSON.parse(fake.hits[3]?.body ?? "{}")).toMatchObject({
      idempotencyKey: "done-1",
      result: { ok: true },
    });
    await ledger.close();
  });

  it("returns null when getTask is 404", async () => {
    const fake = await listen((_req, _body, res) => {
      json(res, 404, { code: "not_found", message: "missing", status: 404, details: {} });
    });
    const ledger = new Ledger({ mode: "remote", url: fake.url, apiKey: "k" });
    await expect(ledger.getTask("tsk_missing")).resolves.toBeNull();
    await ledger.close();
  });

  it("does not treat 401 as unavailable", async () => {
    const fake = await listen((_req, _body, res) => {
      json(res, 401, { code: "unauthorized", message: "nope", status: 401, details: {} });
    });
    const ledger = new Ledger({
      mode: "remote",
      url: fake.url,
      apiKey: "bad",
      onUnavailable: "allow_read_only",
    });
    await expect(
      ledger.request({
        principalId: "u_1",
        action: { type: "email.read" },
        payload: { action: "email.read", args: {} },
        readOnly: true,
      }),
    ).rejects.toMatchObject({
      name: "LedgerError",
      code: "unauthorized",
      status: 401,
      message: "ActLedger server rejected the API key; check ACTLEDGER_API_KEY",
    });
    await ledger.close();
  });

  it("keeps JSON error fields and maps content_mismatch", async () => {
    const fake = await listen((req, _body, res) => {
      if (req.url?.endsWith("/complete")) {
        json(res, 409, {
          code: "content_mismatch",
          message: "payload drifted",
          status: 409,
          details: { field: "args.to" },
        });
        return;
      }
      if (req.url?.endsWith("/claim")) {
        json(res, 200, {
          task: { id: "tsk_1", state: "executing" },
          approvedPayload: { action: "email.send", args: { to: "a@b.c" } },
          approvedPayloadHash: "sha256:abc",
          executionDeadline: "2026-01-01T00:00:00.000Z",
          receipt: { hash: "sha256:r" },
        });
        return;
      }
      if (req.method === "POST") {
        json(res, 409, { code: "invalid_transition", message: "nope", status: 409, details: { from: "executed" } });
        return;
      }
      json(res, 200, {
        task: { id: "tsk_1", state: "approved" },
        receipts: [],
      });
    });
    const ledger = new Ledger({ mode: "remote", url: fake.url, apiKey: "k", strictContent: true });
    await expect(
      ledger.request({
        principalId: "u_1",
        action: { type: "email.send" },
        payload: { action: "email.send", args: {} },
        idempotencyKey: "once",
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      status: 409,
      details: { from: "executed" },
    });
    const transport = new RemoteTransport({
      url: fake.url,
      apiKey: "k",
      requestTimeoutMs: 5_000,
      allowInsecureHttp: false,
      fetch: globalThis.fetch,
    });
    const claimed = await transport.claim("tsk_1", { idempotencyKey: "c" });
    const runLedger = new Ledger({ mode: "remote", url: fake.url, apiKey: "k" });
    const run = new Run(runLedger, transport, claimed);
    await expect(
      run.complete({ executedPayload: { action: "email.send", args: { to: "a@b.c" } } }),
    ).rejects.toBeInstanceOf(ContentMismatch);
    await ledger.close();
    await runLedger.close();
  });

  it("maps connection refusal to LedgerUnavailable and can degrade a read", async () => {
    const closed = await listen((_req, _body, res) => {
      res.end();
    });
    await closed.close();
    const ledger = new Ledger({ mode: "remote", url: closed.url, apiKey: "k", requestTimeoutMs: 500 });
    await expect(ledger.getTask("tsk_1")).rejects.toBeInstanceOf(LedgerUnavailable);
    const degraded = new Ledger({
      mode: "remote",
      url: closed.url,
      apiKey: "k",
      requestTimeoutMs: 500,
      onUnavailable: "allow_read_only",
    });
    const handle = await degraded.request({
      principalId: "u_1",
      action: { type: "email.read" },
      payload: { action: "email.read", args: {} },
      readOnly: true,
    });
    expect(handle.degraded).toBe(true);
    await ledger.close();
    await degraded.close();
  });

  it("retries 503 twice and does not retry 500", async () => {
    let unavailable = 0;
    const fake = await listen((req, body, res) => {
      if (req.url === "/v1/tasks" && unavailable < 2) {
        unavailable += 1;
        json(res, 503, { code: "internal", message: "down", status: 503, details: {} });
        return;
      }
      const parsed = JSON.parse(body) as { idempotencyKey?: string };
      json(res, 200, { task: { id: "tsk_ok", state: "approved", idempotencyKey: parsed.idempotencyKey }, receipts: [] });
    });
    const ledger = new Ledger({ mode: "remote", url: fake.url, apiKey: "k" });
    const task = await ledger.request({
      principalId: "u_1",
      action: { type: "email.read" },
      payload: { action: "email.read", args: {} },
      idempotencyKey: "same-key",
    });
    expect(task.id).toBe("tsk_ok");
    expect(fake.hits).toHaveLength(3);
    const keys = fake.hits.map((hit) => (JSON.parse(hit.body) as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(["same-key", "same-key", "same-key"]);

    let errors = 0;
    const fatal = await listen((_req, _body, res) => {
      errors += 1;
      json(res, 500, { code: "internal", message: "boom", status: 500, details: {} });
    });
    const broken = new Ledger({ mode: "remote", url: fatal.url, apiKey: "k" });
    await expect(
      broken.request({
        principalId: "u_1",
        action: { type: "email.read" },
        payload: { action: "email.read", args: {} },
        idempotencyKey: "once",
      }),
    ).rejects.toMatchObject({ message: "ActLedger server error 500" });
    expect(errors).toBe(1);

    let bare = 0;
    const noKey = await listen((_req, _body, res) => {
      bare += 1;
      json(res, 503, { code: "internal", message: "down", status: 503, details: {} });
    });
    const transport = new RemoteTransport({
      url: noKey.url,
      apiKey: "k",
      requestTimeoutMs: 5_000,
      allowInsecureHttp: false,
      fetch: globalThis.fetch,
    });
    await expect(
      transport.request({
        principalId: "u_1",
        action: { type: "email.read" },
        payload: { action: "email.read", args: {} },
      }),
    ).rejects.toBeInstanceOf(LedgerUnavailable);
    expect(bare).toBe(1);
    await ledger.close();
    await broken.close();
  });

  it("rejects a 2xx body that is not a JSON object", async () => {
    const fake = await listen((_req, _body, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const ledger = new Ledger({ mode: "remote", url: fake.url, apiKey: "k" });
    await expect(ledger.getTask("tsk_1")).rejects.toMatchObject({
      message: "ActLedger server returned an invalid response",
    });
    await ledger.close();
  });

  it("rejects coverage overlay and ignores sweep", async () => {
    const fake = await listen((_req, _body, res) => {
      json(res, 200, { task: null });
    });
    const ledger = new Ledger({ mode: "remote", url: fake.url, apiKey: "k" });
    await expect(ledger.setCoverageOverlay([])).rejects.toMatchObject({ code: "remote_unsupported" });
    await expect(ledger.sweep()).resolves.toBeUndefined();
    expect(fake.hits).toHaveLength(0);
    await ledger.close();
  });

  it("polls every second and points approval at the console", async () => {
    const ledger = new Ledger({ mode: "remote", url: "http://127.0.0.1:9", apiKey: "k" });
    expect(ledger.pollMs).toBe(1000);
    expect(ledger.approveHint("tsk_x")).toBe(
      "Task tsk_x is waiting for approval. Approve or reject it in the ActLedger console: http://127.0.0.1:9/tasks/tsk_x",
    );
    expect(ledger.approveHint("tsk_x", { minAssurance: "channel_verified", stepUp: null })).toContain("cannot record");
    expect(ledger.approveHint("tsk_x", { minAssurance: "channel_verified", stepUp: "webauthn" })).toContain(
      "channel_verified and step-up",
    );
    await ledger.close();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-remote-hint-"));
    dirs.push(dir);
    initLocalDir(dir);
    const local = new Ledger({ mode: "local", dir });
    expect(local.pollMs).toBe(200);
    expect(local.approveHint("tsk_1")).toBe(approveHint("tsk_1", local.dir));
    expect(local.approveHint("tsk_1", { minAssurance: "channel_verified", stepUp: null })).toBe(
      approveHint("tsk_1", local.dir, { minAssurance: "channel_verified", stepUp: null }),
    );
    expect(local.approveHint("tsk_1")).toBe(
      `Task tsk_1 is waiting for approval. Approve: actledger approve tsk_1 --dir ${local.dir}  Reject: actledger reject tsk_1 --dir ${local.dir} --note "<reason>"`,
    );
    await local.close();
  });
});
