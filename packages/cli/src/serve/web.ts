import http from "node:http";
import { checkBrowserPost, safeEqual } from "./auth.js";

export const TASK_ID = /^tsk_[0-9A-Za-z_]{1,64}$/;
export const FORM_LIMIT = 16 * 1024;

export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly plain = false,
  ) {
    super(message);
  }
}

export function assertBrowser(req: http.IncomingMessage, origins: Set<string>): void {
  const verdict = checkBrowserPost(req.headers, origins);
  if (verdict === "origin_rejected") throw new HttpFail(403, "origin_rejected", "origin rejected");
  if (verdict === "fetch_site_rejected") throw new HttpFail(403, "fetch_site_rejected", "cross-site request rejected");
}

export function assertCsrf(form: Map<string, string>, csrf: string): void {
  if (!safeEqual(csrf, form.get("csrf") ?? "")) throw new HttpFail(403, "csrf_failed", "csrf failed");
}

export function requiredNote(form: Map<string, string>): string {
  const note = (form.get("reason") ?? "").trim();
  if (!note) throw new HttpFail(400, "reason_required", "a rejection needs a reason");
  if (note.length > 2000) throw new HttpFail(400, "invalid_request", "reason is longer than 2000 characters");
  return note;
}

export async function readForm(req: http.IncomingMessage): Promise<Map<string, string>> {
  if (mediaType(req.headers["content-type"]) !== "application/x-www-form-urlencoded") {
    req.resume();
    throw new HttpFail(415, "unsupported_media_type", "unsupported media type", true);
  }
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const form = new Map<string, string>();
  for (const [key, value] of params) {
    if (!form.has(key)) form.set(key, value);
  }
  return form;
}

export async function readBody(req: http.IncomingMessage, limit = FORM_LIMIT): Promise<string> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > limit) {
    req.resume();
    throw new HttpFail(413, "payload_too_large", "payload too large", true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpFail(413, "payload_too_large", "payload too large", true);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function mediaType(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function redirect(res: http.ServerResponse, location: string, setCookie?: string): void {
  send(res, 303, "", "text/plain; charset=utf-8", {
    Location: location,
    ...(setCookie ? { "Set-Cookie": setCookie } : {}),
  });
}

export function sendText(res: http.ServerResponse, status: number, body: string): void {
  send(res, status, body, "text/plain; charset=utf-8");
}

export function sendHtml(res: http.ServerResponse, status: number, body: string, extra?: Record<string, string>): void {
  send(res, status, body, "text/html; charset=utf-8", extra);
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

export function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  type: string,
  extra?: Record<string, string>,
): void {
  const prior = res.getHeader("Set-Cookie");
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extra,
  };
  if (prior !== undefined && extra?.["Set-Cookie"]) {
    headers["Set-Cookie"] = [...(Array.isArray(prior) ? prior : [String(prior)]), extra["Set-Cookie"]];
  }
  res.writeHead(status, headers);
  res.end(body);
}
