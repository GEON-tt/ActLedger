import { createHmac } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiver } from "../receiver";

const secret = "dev-secret";
const servers: http.Server[] = [];

function sign(body: Buffer, t = Math.floor(Date.now() / 1000)): string {
  const hex = createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex");
  return `t=${t},v1=${hex}`;
}

function eventBody(approveUrl: string | null, id = "evt_1"): Buffer {
  return Buffer.from(
    JSON.stringify({
      id,
      type: "task.pending_approval",
      created_at: "2026-10-15T00:00:00.000Z",
      data: {
        task_id: "tsk_1",
        state: "pending_approval",
        approve_url: approveUrl,
        detail_url: "http://127.0.0.1:4319/tasks/tsk_1",
      },
    }),
  );
}

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function post(port: number, body: Buffer, header: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "actledger-signature": header, connection: "close" },
    body,
  });
  return response.status;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("webhook receiver", () => {
  it("accepts a signed event, prints the approve link, and drops a retry", async () => {
    const lines: string[] = [];
    const port = await listen(createReceiver(secret, (line) => lines.push(line)));
    const body = eventBody("http://127.0.0.1:4319/l/x");
    const header = sign(body);

    expect(await post(port, body, header)).toBe(204);
    expect(lines).toEqual([
      "task.pending_approval tsk_1 state=pending_approval",
      "approve_url: http://127.0.0.1:4319/l/x",
    ]);

    expect(await post(port, body, header)).toBe(204);
    expect(lines).toHaveLength(2);
  });

  it("rejects a signature that is off by one character", async () => {
    const lines: string[] = [];
    const port = await listen(createReceiver(secret, (line) => lines.push(line)));
    const body = eventBody("http://127.0.0.1:4319/l/x", "evt_bad");
    const header = sign(body).replace(/.$/, (char) => (char === "a" ? "b" : "a"));

    expect(await post(port, body, header)).toBe(401);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("rejected:")).toBe(true);
  });

  it("returns 404 for GET /hook", async () => {
    const port = await listen(createReceiver(secret, () => {}));
    const response = await fetch(`http://127.0.0.1:${port}/hook`, { headers: { connection: "close" } });
    expect(response.status).toBe(404);
  });

  it("does not print approve_url when it is null", async () => {
    const lines: string[] = [];
    const port = await listen(createReceiver(secret, (line) => lines.push(line)));
    const body = eventBody(null, "evt_null");

    expect(await post(port, body, sign(body))).toBe(204);
    expect(lines).toEqual(["task.pending_approval tsk_1 state=pending_approval"]);
  });
});
