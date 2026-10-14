import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { LedgerError } from "@actledger/core";

export const CHANNELS_EXAMPLE = `# ActLedger notification channels, read by \`actledger serve\`.
# Everything below is commented out, so serve starts with zero channels.
# Secrets are never written here. secret_env names an environment variable.
#
# public_url: http://127.0.0.1:4319
# channels:
#   - name: team-webhook
#     type: webhook
#     url: https://example.com/actledger-hook
#     secret_env: ACTLEDGER_WEBHOOK_SECRET
#     events: [task.pending_approval, task.approved, task.rejected]
#     include_payload: false
#
# Signed approve links in webhooks need \`webhook_link\` in policy.yaml
# approval.channels. Links point at public_url and expire after 15 minutes.
`;

export type ChannelEvent = "task.pending_approval" | "task.approved" | "task.rejected";

export interface WebhookChannel {
  name: string;
  type: "webhook";
  url: string;
  secretEnv: string;
  events: ChannelEvent[];
  includePayload: boolean;
}

export interface ChannelsConfig {
  publicUrl: string | null;
  channels: WebhookChannel[];
  skipped: Array<{ name: string; reason: "missing_secret_env"; secretEnv: string }>;
}

const EVENTS = new Set<ChannelEvent>(["task.pending_approval", "task.approved", "task.rejected"]);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const CHANNEL_KEYS = new Set(["name", "type", "url", "secret_env", "events", "include_payload"]);

export function channelSecret(channel: WebhookChannel, env: NodeJS.ProcessEnv): string | null {
  const value = env[channel.secretEnv];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

export function isLoopbackUrl(value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export function loadChannelsConfig(dir: string, opts: { env: NodeJS.ProcessEnv }): ChannelsConfig {
  const file = path.join(path.resolve(dir), "channels.yaml");
  if (!fs.existsSync(file)) return { publicUrl: null, channels: [], skipped: [] };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    throw fail(file, message);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "yaml parse failed";
    throw fail(file, message);
  }
  if (raw == null) return { publicUrl: null, channels: [], skipped: [] };
  if (!isRecord(raw)) throw fail(file, "top level must be an object");
  for (const key of Object.keys(raw)) {
    if (key !== "public_url" && key !== "channels") throw fail(file, `unknown key ${key}`);
  }
  const publicUrl = raw.public_url === undefined ? null : parsePublicUrl(file, raw.public_url);
  const channels: WebhookChannel[] = [];
  const skipped: ChannelsConfig["skipped"] = [];
  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels)) throw fail(file, "channels must be an array");
    const names = new Set<string>();
    raw.channels.forEach((item, index) => {
      const channel = parseChannel(file, item, index);
      if (names.has(channel.name)) throw fail(file, `channels[${index}].name is duplicated`);
      names.add(channel.name);
      if (!channelSecret(channel, opts.env)) {
        skipped.push({ name: channel.name, reason: "missing_secret_env", secretEnv: channel.secretEnv });
        return;
      }
      channels.push(channel);
    });
  }
  return { publicUrl, channels, skipped };
}

function parsePublicUrl(file: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw fail(file, "public_url must be an http(s) URL");
  return normalizeHttpUrl(file, "public_url", value, true);
}

function parseChannel(file: string, value: unknown, index: number): WebhookChannel {
  const where = `channels[${index}]`;
  if (!isRecord(value)) throw fail(file, `${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!CHANNEL_KEYS.has(key)) throw fail(file, `${where} has unknown key ${key}`);
  }
  const name = value.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw fail(file, `${where}.name must match ${NAME_RE.source}`);
  }
  if (value.type !== "webhook") throw fail(file, `${where}.type must be webhook`);
  if (typeof value.url !== "string") throw fail(file, `${where}.url must be an http(s) URL`);
  const url = normalizeHttpUrl(file, `${where}.url`, value.url, false);
  const secretEnv = value.secret_env;
  if (typeof secretEnv !== "string" || !ENV_RE.test(secretEnv)) {
    throw fail(file, `${where}.secret_env must be an environment variable name`);
  }
  let events: ChannelEvent[];
  if (value.events === undefined) {
    events = ["task.pending_approval"];
  } else if (!Array.isArray(value.events) || value.events.length === 0) {
    throw fail(file, `${where}.events must be a non-empty array`);
  } else {
    events = value.events.map((event, eventIndex) => {
      if (typeof event !== "string" || !EVENTS.has(event as ChannelEvent)) {
        throw fail(file, `${where}.events contains unknown event ${String(event)} at ${eventIndex}`);
      }
      return event as ChannelEvent;
    });
  }
  if (value.include_payload !== undefined && typeof value.include_payload !== "boolean") {
    throw fail(file, `${where}.include_payload must be a boolean`);
  }
  return {
    name,
    type: "webhook",
    url,
    secretEnv,
    events,
    includePayload: value.include_payload ?? false,
  };
}

function normalizeHttpUrl(file: string, label: string, value: string, rejectQuery: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail(file, `${label} must be an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail(file, `${label} must be an http(s) URL`);
  if (rejectQuery && (url.search || url.hash)) throw fail(file, `${label} must not include a query or hash`);
  url.hash = "";
  if (rejectQuery) url.search = "";
  let normalized = url.toString();
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(file: string, message: string): LedgerError {
  return new LedgerError("invalid_request", `channels.yaml: ${file}: ${message}`, 400);
}
