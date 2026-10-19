import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDemo, type DemoHandle } from "../run.js";

const CHAT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

let current: { demo: DemoHandle; dataDir: string } | undefined;

afterEach(async () => {
  const running = current;
  current = undefined;
  if (!running) return;
  try {
    await running.demo.close();
  } finally {
    fs.rmSync(running.dataDir, { recursive: true, force: true });
  }
});

function request(
  port: number,
  method: string,
  requestPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path: requestPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function boot(): Promise<DemoHandle> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-chat-ui-"));
  try {
    const demo = await startDemo({
      dataDir,
      servePort: 0,
      chatPort: 0,
      provider: "fake",
      env: {},
      log: () => {},
      gatePollMs: 250,
    });
    current = { demo, dataDir };
    return demo;
  } catch (error) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

describe("chat approval page", () => {
  it("serves the locked CSP and no external resources", async () => {
    const demo = await boot();
    const home = await request(demo.chat.port, "GET", "/");
    expect(home.status).toBe(200);
    expect(home.headers["content-security-policy"]).toBe(CHAT_CSP);
    expect(home.body).not.toMatch(/\b(?:src|href|action|xmlns(?::\w+)?|poster|srcset)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
    expect(home.body).not.toMatch(/url\(|@import|@font-face/i);
    expect(home.body).not.toMatch(/<(?:img|link|iframe|object|embed)\b/i);
    expect(home.body).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
