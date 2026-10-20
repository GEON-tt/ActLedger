import { randomBytes, timingSafeEqual } from "node:crypto";
import type { LoginCredential } from "./token.js";

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 24 * 60 * 60 * 1000;

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function sessionCookie(id: string, opts?: { secure?: boolean }): string {
  return `actledger_session=${id}; HttpOnly; SameSite=Strict; Path=/${opts?.secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(opts?: { secure?: boolean }): string {
  return `actledger_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${opts?.secure ? "; Secure" : ""}`;
}

export interface LoginSource {
  readonly oneTime: boolean;
  current(): LoginCredential;
}

interface Session {
  csrf: string;
  createdAt: number;
  lastSeen: number;
  loginGeneration: number;
  loginDigest: string;
}

export class SessionStore {
  private loginUsed = false;
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => Date,
    private readonly source: LoginSource,
  ) {}

  login(token: string): { id: string; csrf: string } | null {
    const cred = this.source.current();
    if (!safeEqual(cred.token, token)) return null;
    if (this.source.oneTime) {
      if (this.loginUsed) return null;
      this.loginUsed = true;
    }
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const ts = this.now().getTime();
    this.sessions.set(id, {
      csrf,
      createdAt: ts,
      lastSeen: ts,
      loginGeneration: cred.generation,
      loginDigest: cred.digest,
    });
    return { id, csrf };
  }

  get(id: string | undefined): { csrf: string } | null {
    if (!id) return null;
    const row = this.sessions.get(id);
    if (!row) return null;
    const ts = this.now().getTime();
    if (ts - row.createdAt >= ABSOLUTE_MS || ts - row.lastSeen >= IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    const cred = this.source.current();
    if (row.loginGeneration !== cred.generation || row.loginDigest !== cred.digest) {
      this.sessions.delete(id);
      return null;
    }
    row.lastSeen = ts;
    return { csrf: row.csrf };
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

export function allowedHosts(port: number, publicUrl: string): Set<string> {
  return new Set(
    [`127.0.0.1:${port}`, `localhost:${port}`, new URL(publicUrl).host].map((host) => host.toLowerCase()),
  );
}

export function allowedOrigins(port: number, publicUrl: string): Set<string> {
  return new Set(
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`, new URL(publicUrl).origin].map((origin) =>
      origin.toLowerCase(),
    ),
  );
}

export function hostAllowed(header: string | undefined, hosts: Set<string>): boolean {
  if (!header) return false;
  return hosts.has(header.toLowerCase());
}

export function originAllowed(header: string | string[] | undefined, origins: Set<string>): boolean {
  if (typeof header !== "string" || header.length === 0) return false;
  return origins.has(header.toLowerCase());
}

export function fetchSiteAllowed(header: string | string[] | undefined): boolean {
  if (header === undefined) return true;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return true;
  return value === "same-origin" || value === "none";
}

export type BrowserVerdict = "ok" | "origin_rejected" | "fetch_site_rejected";

export function checkBrowserPost(
  headers: { origin?: string | string[]; "sec-fetch-site"?: string | string[]; referer?: string | string[] },
  origins: Set<string>,
): BrowserVerdict {
  const origin = headerValue(headers.origin);
  const site = headerValue(headers["sec-fetch-site"]);
  const referer = headerValue(headers.referer);
  const siteAllowed = site === "same-origin" || site === "none";
  const siteRejected = Boolean(site) && !siteAllowed;

  if (origin && origin !== "null") {
    if (!origins.has(origin.toLowerCase())) return "origin_rejected";
    if (siteRejected) return "fetch_site_rejected";
    return "ok";
  }

  if (siteRejected) return "fetch_site_rejected";
  if (referer) {
    let refererOrigin = "";
    try {
      refererOrigin = new URL(referer).origin.toLowerCase();
    } catch {
      return "origin_rejected";
    }
    if (!origins.has(refererOrigin)) return "origin_rejected";
  }
  if (siteAllowed || Boolean(referer)) return "ok";
  return "origin_rejected";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}
