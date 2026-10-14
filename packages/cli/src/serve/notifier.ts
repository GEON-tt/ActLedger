import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  effectiveChannels,
  formatTimestamp,
  LedgerError,
  newId,
  type LedgerEngine,
  type State,
  type TaskView,
} from "@actledger/core";
import { channelSecret, type ChannelEvent, type ChannelsConfig, type WebhookChannel } from "./channels.js";
import { LINK_TTL_SECONDS, signLink } from "./links.js";

export function signWebhook(rawBody: string, secret: string, nowSeconds: number): string {
  const t = String(Math.floor(nowSeconds));
  const v1 = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  return `t=${t},v1=${v1}`;
}

export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;

export async function defaultHttpPost(
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<{ status: number }> {
  const response = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: "manual",
  });
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status };
}

export interface NotifierOptions {
  dir: string;
  engine: LedgerEngine;
  config: ChannelsConfig;
  publicUrl: string;
  linkKey: Buffer;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  httpPost: HttpPost;
  retryBaseMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

interface Notice {
  id: string;
  type: ChannelEvent;
  task: TaskView;
  createdAt: string;
  approveUrl: string | null;
}

interface Outbound {
  id: string;
  type: ChannelEvent;
  taskId: string;
  rawBody: string;
}

export class Notifier {
  private readonly statePath: string;
  private readonly logPath: string;
  private readonly lastState = new Map<string, State>();
  private readonly tails = new Map<string, Promise<void>>();
  private hadFile: boolean;
  private booted = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: NotifierOptions) {
    this.statePath = path.join(opts.dir, "notify-state.json");
    this.logPath = path.join(opts.dir, "notify.log");
    this.hadFile = fs.existsSync(this.statePath);
    if (this.hadFile) {
      for (const [id, state] of readState(this.statePath)) this.lastState.set(id, state);
    }
    for (const skipped of opts.config.skipped) {
      this.writeLog({
        ts: formatTimestamp(opts.now()),
        channel: skipped.name,
        outcome: "skipped",
        reason: skipped.reason,
        secret_env: skipped.secretEnv,
      });
    }
  }

  start(pollMs: number): void {
    if (pollMs <= 0 || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  tick(): Promise<void> {
    if (this.stopped) return this.chain;
    this.chain = this.chain
      .then(() => {
        if (!this.stopped) this.scan();
      })
      .then(
        () => undefined,
        (error: unknown) => {
          const message = error instanceof Error ? error.message : "tick failed";
          this.opts.log(`notifier: ${message}`);
        },
      );
    return this.chain;
  }

  flush(): Promise<void> {
    return Promise.all([...this.tails.values()]).then(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.chain;
    await this.flush();
  }

  private scan(): void {
    if (this.opts.config.channels.length === 0) return;
    const tasks = this.opts.engine.listTasks();
    const notices: Notice[] = [];
    if (!this.hadFile && !this.booted) {
      for (const task of tasks) {
        if (task.state === "pending_approval") notices.push(this.notice(task, "task.pending_approval"));
        this.lastState.set(task.id, task.state);
      }
      this.booted = true;
      this.persist();
      this.queue(notices);
      return;
    }
    for (const task of tasks) {
      const prev = this.lastState.get(task.id);
      if (prev !== task.state) {
        if (task.state === "pending_approval") notices.push(this.notice(task, "task.pending_approval"));
        else if (task.state === "approved" && task.approvalId != null) notices.push(this.notice(task, "task.approved"));
        else if (task.state === "rejected" && task.approvalId != null) notices.push(this.notice(task, "task.rejected"));
      }
      this.lastState.set(task.id, task.state);
    }
    this.booted = true;
    this.persist();
    this.queue(notices);
  }

  private notice(task: TaskView, type: ChannelEvent): Notice {
    const approveUrl = type === "task.pending_approval" ? this.approveUrl(task) : null;
    return {
      id: newId("evt", this.opts.now().getTime()),
      type,
      task,
      createdAt: formatTimestamp(this.opts.now()),
      approveUrl,
    };
  }

  private approveUrl(task: TaskView): string | null {
    if (!effectiveChannels(task.decision).includes("webhook_link")) return null;
    const exp = Math.floor(this.opts.now().getTime() / 1000) + LINK_TTL_SECONDS;
    const sig = signLink(this.opts.linkKey, {
      appId: task.appId,
      taskId: task.id,
      payloadHash: task.payloadHash,
      exp,
    });
    return `${this.opts.publicUrl}/t/${task.id}?sig=${sig}&exp=${exp}`;
  }

  private queue(notices: Notice[]): void {
    for (const notice of notices) {
      for (const channel of this.opts.config.channels) {
        if (!channel.events.includes(notice.type)) continue;
        const rawBody = this.rawBody(channel, notice);
        const outbound: Outbound = { id: notice.id, type: notice.type, taskId: notice.task.id, rawBody };
        this.enqueue(channel.name, () => this.deliver(channel, outbound));
      }
    }
  }

  private rawBody(channel: WebhookChannel, notice: Notice): string {
    const task = notice.task;
    const data: Record<string, unknown> = {
      task_id: task.id,
      state: task.state,
      action: {
        type: task.action.type,
        level: task.action.level,
        resource: task.action.resource,
      },
      payload_hash: task.payloadHash,
      intent_commit: task.intentCommit,
      task_created_at: task.createdAt,
      approve_url: notice.approveUrl,
      detail_url: `${this.opts.publicUrl}/tasks/${task.id}`,
    };
    if (notice.type === "task.approved" || notice.type === "task.rejected") data.decided_by = "user";
    if (channel.includePayload) {
      try {
        data.payload = this.opts.engine.taskPayload(task.id);
      } catch {
        data.payload = null;
      }
      try {
        data.intent = this.opts.engine.taskIntent(task.id);
      } catch {
        data.intent = null;
      }
    }
    return JSON.stringify({
      id: notice.id,
      type: notice.type,
      created_at: notice.createdAt,
      data,
    });
  }

  private enqueue(name: string, job: () => Promise<void>): void {
    const prev = this.tails.get(name) ?? Promise.resolve();
    const next = prev.then(job).then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(name, next);
  }

  private async deliver(channel: WebhookChannel, event: Outbound): Promise<void> {
    const host = urlHost(channel.url);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const secret = channelSecret(channel, this.opts.env);
      if (!secret) {
        this.writeLog({
          ts: formatTimestamp(this.opts.now()),
          event_id: event.id,
          event: event.type,
          task_id: event.taskId,
          channel: channel.name,
          attempt,
          outcome: "skipped",
          reason: "missing_secret_env",
          secret_env: channel.secretEnv,
          url_host: host,
        });
        return;
      }
      const signature = signWebhook(event.rawBody, secret, this.opts.now().getTime() / 1000);
      try {
        const response = await this.opts.httpPost(channel.url, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "actledger-serve/0.1.0",
            "ActLedger-Signature": signature,
            "ActLedger-Event": event.type,
            "ActLedger-Delivery": event.id,
          },
          body: event.rawBody,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status >= 200 && response.status < 300) {
          this.writeLog({
            ts: formatTimestamp(this.opts.now()),
            event_id: event.id,
            event: event.type,
            task_id: event.taskId,
            channel: channel.name,
            attempt,
            outcome: "delivered",
            status: response.status,
            url_host: host,
          });
          return;
        }
        const retry = response.status === 429 || response.status >= 500;
        if (retry && attempt < 4) {
          this.writeLog({
            ts: formatTimestamp(this.opts.now()),
            event_id: event.id,
            event: event.type,
            task_id: event.taskId,
            channel: channel.name,
            attempt,
            outcome: "retry",
            status: response.status,
            url_host: host,
          });
          await this.opts.sleep(this.opts.retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
        this.writeLog({
          ts: formatTimestamp(this.opts.now()),
          event_id: event.id,
          event: event.type,
          task_id: event.taskId,
          channel: channel.name,
          attempt,
          outcome: "failed",
          status: response.status,
          error: `HTTP ${response.status}`,
          url_host: host,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "request failed";
        if (attempt < 4) {
          this.writeLog({
            ts: formatTimestamp(this.opts.now()),
            event_id: event.id,
            event: event.type,
            task_id: event.taskId,
            channel: channel.name,
            attempt,
            outcome: "retry",
            error: message,
            url_host: host,
          });
          await this.opts.sleep(this.opts.retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
        this.writeLog({
          ts: formatTimestamp(this.opts.now()),
          event_id: event.id,
          event: event.type,
          task_id: event.taskId,
          channel: channel.name,
          attempt,
          outcome: "failed",
          error: message,
          url_host: host,
        });
        return;
      }
    }
  }

  private persist(): void {
    const tasks: Record<string, string> = {};
    for (const [id, state] of this.lastState) tasks[id] = state;
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, tasks })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }

  private writeLog(fields: Record<string, string | number | undefined>): void {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) out[key] = value;
    }
    fs.appendFileSync(this.logPath, `${JSON.stringify(out)}\n`, { mode: 0o600 });
    fs.chmodSync(this.logPath, 0o600);
  }
}

function readState(file: string): Map<string, State> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("invalid_request", `notify-state.json: ${file}: invalid json`, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LedgerError("invalid_request", `notify-state.json: ${file}: invalid`, 400);
  }
  const record = raw as { v?: unknown; tasks?: unknown };
  if (record.v !== 1 || !record.tasks || typeof record.tasks !== "object" || Array.isArray(record.tasks)) {
    throw new LedgerError("invalid_request", `notify-state.json: ${file}: invalid`, 400);
  }
  const states = new Map<string, State>();
  for (const [id, state] of Object.entries(record.tasks as Record<string, unknown>)) {
    if (typeof state !== "string") {
      throw new LedgerError("invalid_request", `notify-state.json: ${file}: invalid task state`, 400);
    }
    states.set(id, state as State);
  }
  return states;
}

function urlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
