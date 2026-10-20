import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "@actledger/cli/console";
import { CredentialStore } from "../src/store.js";
import { serverDbPath } from "../src/data.js";
import { startServer } from "../src/server.js";
import { newTotpSecret, totpCode } from "../src/totp.js";
import { addUser, agentKey, api, boot, cleanup, field, form, login, request, tempData, track } from "./helpers.js";

let data = "";
let alice = { secret: "", password: "" };
let bob = { secret: "", password: "" };
let key = "";
let port = 0;
let clock = { now: new Date("2026-01-05T00:00:00.000Z") };

beforeEach(async () => {
  data = tempData();
  alice = await addUser(data, "alice", "u_1");
  bob = await addUser(data, "bob", "u_2");
  key = agentKey(data, "agent-1", ["u_1", "u_2"]);
  const booted = await boot(data);
  port = booted.handle.port;
  clock = booted.clock;
});

afterEach(async () => {
  await cleanup();
});

function cookieHeader(cookie: string | null): Record<string, string> {
  return { cookie: cookie ?? "" };
}

async function submit(principalId: string, action = "email.send"): Promise<string> {
  const created = await api(port, "POST", "/v1/tasks", key, {
    principalId,
    action: { type: action },
    payload: { action, args: { to: "bob@example.com" } },
  });
  expect(created.status).toBe(200);
  return created.json.task.id as string;
}

describe("remote console", () => {
  it("logs in with a totp code and sets a host-only cookie", async () => {
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    expect(logged.status).toBe(303);
    expect(logged.headers.location).toBe("/");
    const setCookie = Array.isArray(logged.headers["set-cookie"])
      ? logged.headers["set-cookie"].join("\n")
      : (logged.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("actledger_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("; Secure");
  });

  it("rejects a wrong authenticator code", async () => {
    const logged = await login(port, "alice", alice.password, "000000");
    expect(logged.status).toBe(401);
    expect(logged.body).toContain("Wrong username, password, or authenticator code.");
    expect(logged.cookie).toBeNull();
  });

  it("refuses to reuse a code in the same step", async () => {
    const code = totpCode(alice.secret, clock.now);
    expect((await login(port, "alice", alice.password, code)).status).toBe(303);
    expect((await login(port, "alice", alice.password, code)).status).toBe(401);
    clock.now = new Date(clock.now.getTime() + 30_000);
    expect((await login(port, "alice", alice.password, totpCode(alice.secret, clock.now))).status).toBe(303);
  });

  it("accepts the previous step and rejects the one before that", async () => {
    const start = new Date(clock.now);
    clock.now = new Date(start.getTime() + 30_000);
    expect((await login(port, "alice", alice.password, totpCode(alice.secret, new Date(start.getTime() - 30_000)))).status).toBe(401);
    expect((await login(port, "alice", alice.password, totpCode(alice.secret, start))).status).toBe(303);
  });

  it("locks the account after five bad passwords", async () => {
    for (let i = 0; i < 5; i++) {
      const failed = await login(port, "alice", "wrong password!!", "000000");
      expect(failed.status).toBe(401);
    }
    const locked = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    expect(locked.status).toBe(429);
    expect(locked.body).toContain("Too many failed attempts");
    clock.now = new Date(clock.now.getTime() + 15 * 60_000 + 1000);
    expect((await login(port, "alice", alice.password, totpCode(alice.secret, clock.now))).status).toBe(303);
  });

  it("limits an address after twenty failures", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await login(port, `nobody${i}`, "not-a-real-password", "000000")).status).toBe(401);
    }
    const blocked = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("locks an unknown username like a real account", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(port, "ghost", "not-a-real-password", "000000")).status).toBe(401);
    }
    const locked = await login(port, "ghost", "not-a-real-password", "000000");
    expect(locked.status).toBe(429);
    expect(locked.body).toContain("Too many failed attempts");
    expect(locked.headers["retry-after"]).toBeTruthy();
  });

  it("lets at most five concurrent password checks per user", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => login(port, "alice", "wrong password!!", "000000")),
    );
    const verified = results.filter((result) => result.status === 401);
    const limited = results.filter((result) => result.status === 429);
    expect(verified.length).toBeLessThanOrEqual(5);
    expect(limited.length).toBeGreaterThanOrEqual(5);
    expect(verified.length + limited.length).toBe(results.length);
  });

  it("lets at most twenty concurrent attempts per address", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => login(port, `crowd${index}`, "not-a-real-password", "000000")),
    );
    const verified = results.filter((result) => result.status === 401);
    const limited = results.filter((result) => result.status === 429);
    expect(verified.length).toBeLessThanOrEqual(20);
    expect(limited.length).toBeGreaterThanOrEqual(5);
    expect(verified.length + limited.length).toBe(results.length);
  });

  it("expires an idle session after 30 minutes", async () => {
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    expect(logged.status).toBe(303);
    clock.now = new Date(clock.now.getTime() + 30 * 60_000);
    expect((await request(port, "GET", "/api/tasks", { headers: cookieHeader(logged.cookie) })).status).toBe(401);
  });

  it("expires a session 12 hours after it was created", async () => {
    const start = clock.now.getTime();
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    expect(logged.status).toBe(303);
    for (let step = 1; step <= 28; step++) {
      clock.now = new Date(start + step * 25 * 60_000);
      expect((await request(port, "GET", "/api/tasks", { headers: cookieHeader(logged.cookie) })).status).toBe(200);
    }
    clock.now = new Date(start + 12 * 60 * 60_000);
    expect((await request(port, "GET", "/api/tasks", { headers: cookieHeader(logged.cookie) })).status).toBe(401);
  });

  it("shows a user only their own tasks", async () => {
    const aliceId = await submit("u_1");
    const bobId = await submit("u_2");
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    const page = await request(port, "GET", "/", { headers: cookieHeader(logged.cookie) });
    expect(page.body).toContain(aliceId);
    expect(page.body).not.toContain(bobId);
    const list = await request(port, "GET", "/api/tasks?state=all", { headers: cookieHeader(logged.cookie) });
    const tasks = JSON.parse(list.body).tasks as Array<{ principalId: string }>;
    expect(tasks.every((task) => task.principalId === "u_1")).toBe(true);
    expect((await request(port, "GET", `/tasks/${bobId}`, { headers: cookieHeader(logged.cookie) })).status).toBe(404);
    const csrf = field(page.body, "csrf");
    const denied = await request(port, "POST", `/tasks/${bobId}/approve`, {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf, presented_hash: "sha256:ignored" }),
    });
    expect(denied.status).toBe(404);
    expect((await api(port, "GET", `/v1/tasks/${bobId}`, key)).json.task.state).toBe("pending_approval");
  });

  it("approves and rejects from the console", async () => {
    const approvedId = await submit("u_1");
    const rejectedId = await submit("u_1");
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    const page = await request(port, "GET", `/tasks/${approvedId}`, { headers: cookieHeader(logged.cookie) });
    const approved = await request(port, "POST", `/tasks/${approvedId}/approve`, {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(page.body, "csrf"), presented_hash: field(page.body, "presented_hash") }),
    });
    expect(approved.status).toBe(303);
    expect(approved.headers.location).toBe(`/tasks/${approvedId}`);
    expect((await api(port, "GET", `/v1/tasks/${approvedId}`, key)).json.task.state).toBe("approved");

    const rejectPage = await request(port, "GET", `/tasks/${rejectedId}`, { headers: cookieHeader(logged.cookie) });
    const missing = await request(port, "POST", `/tasks/${rejectedId}/reject`, {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(rejectPage.body, "csrf"), presented_hash: field(rejectPage.body, "presented_hash") }),
    });
    expect(missing.status).toBe(400);
    expect(missing.body).toContain("reason_required");
    const rejected = await request(port, "POST", `/tasks/${rejectedId}/reject`, {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({
        csrf: field(rejectPage.body, "csrf"),
        presented_hash: field(rejectPage.body, "presented_hash"),
        reason: "not this one",
      }),
    });
    expect(rejected.status).toBe(303);
    expect((await api(port, "GET", `/v1/tasks/${rejectedId}`, key)).json.task.state).toBe("rejected");
  });

  it("rejects a missing csrf token, a foreign origin, and a cross-site fetch", async () => {
    const id = await submit("u_1");
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    const page = await request(port, "GET", `/tasks/${id}`, { headers: cookieHeader(logged.cookie) });
    const headers = {
      ...cookieHeader(logged.cookie),
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/x-www-form-urlencoded",
    };
    const noCsrf = await request(port, "POST", `/tasks/${id}/approve`, {
      headers,
      body: form({ presented_hash: field(page.body, "presented_hash") }),
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toContain("csrf_failed");
    const evil = await request(port, "POST", `/tasks/${id}/approve`, {
      headers: { ...headers, origin: "https://evil.example" },
      body: form({ csrf: field(page.body, "csrf"), presented_hash: field(page.body, "presented_hash") }),
    });
    expect(evil.status).toBe(403);
    expect(evil.body).toContain("origin_rejected");
    const loginEvil = await login(port, "alice", alice.password, "000000", { origin: "https://evil.example" });
    expect(loginEvil.status).toBe(403);
    const cross = await request(port, "POST", `/tasks/${id}/approve`, {
      headers: { ...headers, "sec-fetch-site": "cross-site" },
      body: form({ csrf: field(page.body, "csrf"), presented_hash: field(page.body, "presented_hash") }),
    });
    expect(cross.status).toBe(403);
    expect(cross.body).toContain("fetch_site_rejected");
  });

  it("disables approval when the task needs more assurance", async () => {
    const id = await submit("u_1", "db.delete");
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    const page = await request(port, "GET", `/tasks/${id}`, { headers: cookieHeader(logged.cookie) });
    expect(page.body).toContain("this console can only record app_asserted");
    expect(page.body).toContain("<button type=\"submit\" disabled>");
    const forced = await request(port, "POST", `/tasks/${id}/approve`, {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(page.body, "csrf"), presented_hash: field(page.body, "presented_hash") }),
    });
    expect(forced.status).toBe(403);
    expect(forced.body).toContain("assurance_insufficient");
    expect((await api(port, "GET", `/v1/tasks/${id}`, key)).json.task.state).toBe("pending_approval");
    const rejected = await request(port, "POST", `/tasks/${id}/reject`, {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({
        csrf: field(page.body, "csrf"),
        presented_hash: field(page.body, "presented_hash"),
        reason: "too risky",
      }),
    });
    expect(rejected.status).toBe(303);
    expect((await api(port, "GET", `/v1/tasks/${id}`, key)).json.task.state).toBe("rejected");
  });

  it("sends anonymous visitors to log in", async () => {
    expect((await request(port, "GET", "/")).status).toBe(303);
    expect((await request(port, "GET", "/")).headers.location).toBe("/login");
    expect((await request(port, "GET", "/api/tasks")).status).toBe(401);
    expect((await request(port, "POST", "/tasks/x/approve")).status).toBe(401);
    const forged = await request(port, "GET", "/", { headers: { cookie: "actledger_session=forged" } });
    expect(forged.status).toBe(303);
    expect(forged.headers.location).toBe("/login");
  });

  it("ends a session on logout and when totp is reset", async () => {
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    const page = await request(port, "GET", "/", { headers: cookieHeader(logged.cookie) });
    const out = await request(port, "POST", "/logout", {
      headers: {
        ...cookieHeader(logged.cookie),
        origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ csrf: field(page.body, "csrf") }),
    });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe("/login-ended");
    const cleared = Array.isArray(out.headers["set-cookie"]) ? out.headers["set-cookie"].join("\n") : (out.headers["set-cookie"] ?? "");
    expect(cleared).toContain("Max-Age=0");
    expect((await request(port, "GET", "/", { headers: cookieHeader(logged.cookie) })).headers.location).toBe("/login");

    clock.now = new Date(clock.now.getTime() + 30_000);
    const again = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    expect(again.status).toBe(303);
    const admin = CredentialStore.open(serverDbPath(data));
    try {
      admin.resetTotp("alice", newTotpSecret());
    } finally {
      admin.close();
    }
    expect((await request(port, "GET", "/api/tasks", { headers: cookieHeader(again.cookie) })).status).toBe(401);
  });

  it("rejects a foreign host", async () => {
    expect((await request(port, "GET", "/login", { headers: { host: "evil.example" } })).status).toBe(421);
  });

  it("trusts forwarded headers only when asked", async () => {
    const secure = await startServer({
      data,
      port: 0,
      sweepMs: 0,
      trustProxy: true,
      publicUrl: "https://ledger.example.com",
      now: () => clock.now,
    });
    track(secure);
    const headers = {
      host: "ledger.example.com",
      origin: "https://ledger.example.com",
      "x-forwarded-proto": "https",
    };
    const logged = await login(secure.port, "alice", alice.password, totpCode(alice.secret, clock.now), headers);
    expect(logged.status).toBe(303);
    const setCookie = Array.isArray(logged.headers["set-cookie"])
      ? logged.headers["set-cookie"].join("\n")
      : (logged.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("; Secure");

    for (let i = 0; i < 20; i++) {
      expect(
        (
          await login(secure.port, `nobody${i}`, "", "000000", {
            ...headers,
            "x-forwarded-for": "1.1.1.1, 9.9.9.9",
          })
        ).status,
      ).toBe(401);
    }
    const limited = await login(secure.port, "alice", alice.password, totpCode(alice.secret, clock.now), {
      ...headers,
      "x-forwarded-for": "1.1.1.1, 9.9.9.9",
    });
    expect(limited.status).toBe(429);
    clock.now = new Date(clock.now.getTime() + 30_000);
    const other = await login(secure.port, "alice", alice.password, totpCode(alice.secret, clock.now), {
      ...headers,
      "x-forwarded-for": "8.8.8.8",
    });
    expect(other.status).toBe(303);

    const plain = await startServer({
      data,
      port: 0,
      sweepMs: 0,
      trustProxy: false,
      publicUrl: "https://ledger.example.com",
      now: () => clock.now,
    });
    track(plain);
    clock.now = new Date(clock.now.getTime() + 30_000);
    const again = await login(plain.port, "alice", alice.password, totpCode(alice.secret, clock.now), headers);
    expect(again.status).toBe(303);
    const plainCookie = Array.isArray(again.headers["set-cookie"])
      ? again.headers["set-cookie"].join("\n")
      : (again.headers["set-cookie"] ?? "");
    expect(plainCookie).not.toContain("; Secure");
    expect(
      (
        await request(plain.port, "GET", "/login", {
          headers: { host: "evil.example", "x-forwarded-host": "ledger.example.com" },
        })
      ).status,
    ).toBe(421);
  });

  it("uses the remote copy and the shared security headers", async () => {
    const loginPage = await request(port, "GET", "/login");
    expect(loginPage.headers["content-security-policy"]).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    const logged = await login(port, "alice", alice.password, totpCode(alice.secret, clock.now));
    const list = await request(port, "GET", "/", { headers: cookieHeader(logged.cookie) });
    expect(list.headers["content-security-policy"]).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    expect(list.body).toContain("Every decision is written to the server ledger");
    expect(list.body).not.toContain("127.0.0.1 only");
    expect(list.body).not.toContain("--print-login");
    const zh = await request(port, "GET", "/login?lang=zh-CN");
    expect(zh.body).toContain("登录审批台");
  });
});
