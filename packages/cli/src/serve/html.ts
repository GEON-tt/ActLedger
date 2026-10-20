import type { State } from "@actledger/core";
import { isMessageKey, t, tv, type ConsoleVariant, type Locale, type MessageKey } from "./i18n.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const TOKENS_CSS = `/* actledger-tokens:start */
:root {
  color-scheme: light dark;
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --border: #e2e5ea;
  --border-strong: #c9ced6;
  --text: #15181e;
  --text-2: #464d59;
  --text-3: #66707e;
  --primary: #2f5bea;
  --primary-hover: #2449c7;
  --primary-contrast: #ffffff;
  --focus: #2f5bea;
  --pending-fg: #8a5300;
  --pending-bg: #fff4dc;
  --pending-border: #f0c768;
  --ok-fg: #13683a;
  --ok-bg: #e3f5ea;
  --ok-border: #9fd8b4;
  --rejected-fg: #b42318;
  --rejected-bg: #fdeceb;
  --rejected-border: #f4b4ae;
  --muted-fg: #4b5563;
  --muted-bg: #eceff3;
  --muted-border: #d3d8df;
  --failed-fg: #7a1010;
  --failed-bg: #f8dddd;
  --failed-border: #e09a9a;
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --shadow-1: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
  --shadow-2: 0 6px 16px rgba(16, 24, 40, 0.12);
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --surface: #171a21;
    --surface-2: #1f232c;
    --border: #2b303b;
    --border-strong: #3b4250;
    --text: #e8eaef;
    --text-2: #b6bcc7;
    --text-3: #8e96a4;
    --primary: #7c9cff;
    --primary-hover: #9db5ff;
    --primary-contrast: #0f1115;
    --focus: #9db5ff;
    --pending-fg: #f6c66b;
    --pending-bg: #352708;
    --pending-border: #6b4e12;
    --ok-fg: #6fd69a;
    --ok-bg: #0f2c1c;
    --ok-border: #1f5a37;
    --rejected-fg: #ff8a80;
    --rejected-bg: #3a1513;
    --rejected-border: #6e2a25;
    --muted-fg: #b6bcc7;
    --muted-bg: #242934;
    --muted-border: #3b4250;
    --failed-fg: #ffb3b3;
    --failed-bg: #461111;
    --failed-border: #7d2424;
    --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-2: 0 6px 16px rgba(0, 0, 0, 0.5);
  }
}
/* actledger-tokens:end */`;

export type StatusTone = "pending" | "ok" | "rejected" | "muted" | "failed";

export const STATUS_TONE: Record<State, StatusTone> = {
  prepared: "muted",
  pending_approval: "pending",
  approved: "ok",
  executing: "ok",
  executed: "ok",
  failed: "failed",
  unknown: "failed",
  rejected: "rejected",
  drafted: "muted",
  expired: "muted",
  revoked: "muted",
};

export function statusTone(state: string): StatusTone {
  if (Object.hasOwn(STATUS_TONE, state)) return STATUS_TONE[state as State];
  return "muted";
}

export const LEVEL_TONE: Record<string, "low" | "mid" | "high"> = {
  read: "low",
  draft: "low",
  write: "mid",
  send: "high",
  spend: "high",
  delete: "high",
};

const ICON_BRAND = `<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>`;
const ICON_COPY = `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>`;
const ICON_CHECK = `<path d="M5 12l5 5L19 7"/>`;
const ICON_ALERT = `<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>`;
const ICON_INBOX = `<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>`;
const ICON_BACK = `<path d="M15 6l-6 6 6 6"/>`;
const ICON_LOCK = `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`;

function icon(body: string, size: number, className?: string): string {
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

const CONSOLE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }
.mono, code, pre { font-family: var(--font-mono); }
code { font-size: .86em; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); padding: 20px; }
.btn { display: inline-flex; align-items: center; gap: 6px; font: 600 14px/20px var(--font-sans); padding: 8px 14px; border-radius: var(--radius); border: 1px solid transparent; cursor: pointer; text-decoration: none; }
.btn-primary { background: var(--primary); color: var(--primary-contrast); }
.btn-primary:hover { background: var(--primary-hover); }
.btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); }
.btn-danger { background: var(--surface); color: var(--rejected-fg); border-color: var(--rejected-border); }
.btn-ghost { background: transparent; color: var(--text-2); }
.btn-sm { padding: 5px 10px; font-size: 13px; }
:disabled { opacity: .5; cursor: not-allowed; }
a:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.copy { display: none; width: 28px; height: 28px; padding: 0; align-items: center; justify-content: center; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); cursor: pointer; }
.js .copy { display: inline-flex; }
.copy .i-check { display: none; }
.copy.is-copied .i-copy { display: none; }
.copy.is-copied .i-check { display: inline; }
.callout, .callout-warn, .callout-danger, .callout-muted { display: flex; gap: 10px; padding: 12px 14px; border-radius: var(--radius); border: 1px solid; }
.callout-warn { color: var(--pending-fg); background: var(--pending-bg); border-color: var(--pending-border); }
.callout-danger { color: var(--rejected-fg); background: var(--rejected-bg); border-color: var(--rejected-border); }
.callout-muted { color: var(--muted-fg); background: var(--muted-bg); border-color: var(--muted-border); }
.callout-title { font-weight: 600; margin: 0 0 4px; }
.callout p { margin: 0; }
.banner { margin: 0 0 16px; }
.app-header { background: var(--surface); border-bottom: 1px solid var(--border); }
.app-header-inner, .container { max-width: 1120px; margin: 0 auto; padding: 0 20px; }
body[data-page="list"] .app-header-inner, body[data-page="list"] .container { max-width: 72rem; }
.app-header-inner { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; flex-wrap: wrap; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--text); text-decoration: none; }
.brand-name { font-weight: 700; }
.brand-sub { color: var(--text-3); font-size: 13px; padding-left: 8px; border-left: 1px solid var(--border); }
.header-actions { display: inline-flex; align-items: center; gap: 10px; }
.lang-switch { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 999px; overflow: hidden; }
.lang-switch a { padding: 4px 10px; font-size: 13px; color: var(--text-2); text-decoration: none; }
.lang-switch a[aria-current] { background: var(--surface-2); color: var(--text); font-weight: 600; }
.logout-form { margin: 0; }
.container { padding-top: 24px; padding-bottom: 48px; }
.app-footer { color: var(--text-3); font-size: 13px; text-align: center; padding: 24px 20px 32px; }
.app-footer p { display: inline-flex; align-items: center; gap: 6px; margin: 0; }
.page-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.page-title { font-size: 22px; margin: 0; }
.updated { display: inline-flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 13px; margin: 0; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok-fg); }
.updated.is-error .live-dot { background: var(--failed-fg); }
.updated.is-off .live-dot { background: var(--muted-fg); }
.tabs { display: inline-flex; gap: 4px; padding: 4px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; }
.tab { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: var(--radius-sm); color: var(--text-2); text-decoration: none; font-weight: 600; font-size: 14px; }
.tab[aria-current="page"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-1); }
.tab-count { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--muted-bg); color: var(--muted-fg); font-size: 12px; text-align: center; }
.tab[aria-current="page"] .tab-count { background: var(--primary); color: var(--primary-contrast); }
.list-card { padding: 0; overflow: hidden; }
.table-scroll { overflow-x: auto; }
.tasks { width: 100%; border-collapse: collapse; font-size: 14px; }
.tasks th { text-align: left; font-size: 12px; font-weight: 600; color: var(--text-3); text-transform: none; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--surface-2); white-space: nowrap; }
.tasks td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tasks tr:last-child td { border-bottom: 0; }
.task-row:hover { background: var(--surface-2); }
.task-row[data-state="pending_approval"] .col-task { box-shadow: inset 3px 0 0 var(--pending-border); }
.task-link { color: var(--primary); text-decoration: none; }
.task-link:hover { text-decoration: underline; }
.col-task { overflow: hidden; }
.col-task .task-link { display: block; max-width: min(16rem, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-action code, .col-created, .col-expires, .col-principal, .status, .level, time { white-space: nowrap; }
.col-args, .col-intent { overflow: hidden; }
.clip { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.abs { color: var(--muted-fg); white-space: nowrap; }
.c-task { width: 15%; }
.c-action { width: 12%; }
.c-level { width: 6%; }
.c-state { width: 13%; }
.c-principal { width: 7%; }
.c-created { width: 11%; }
.c-expires { width: 14%; }
.c-args { width: 11%; }
.c-intent { width: 11%; }
.col-expires { overflow: hidden; text-overflow: ellipsis; }
.countdown.is-soon { color: var(--pending-fg); font-weight: 600; }
.countdown.is-expired { color: var(--muted-fg); }
.empty { text-align: center; padding: 48px 24px; }
.empty-icon { display: inline-flex; width: 56px; height: 56px; align-items: center; justify-content: center; border-radius: 50%; background: var(--surface-2); color: var(--text-3); }
.empty-title { font-size: 17px; margin: 16px 0 4px; }
.empty-hint { color: var(--text-2); margin: 0 0 16px; }
.status { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 18px; border: 1px solid; }
.status-pending { color: var(--pending-fg); background: var(--pending-bg); border-color: var(--pending-border); }
.status-ok { color: var(--ok-fg); background: var(--ok-bg); border-color: var(--ok-border); }
.status-rejected { color: var(--rejected-fg); background: var(--rejected-bg); border-color: var(--rejected-border); }
.status-muted { color: var(--muted-fg); background: var(--muted-bg); border-color: var(--muted-border); }
.status-failed { color: var(--failed-fg); background: var(--failed-bg); border-color: var(--failed-border); }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pending .status-dot { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .status-pending .status-dot { animation: none; } }
.level { font: 600 12px/18px var(--font-mono); padding: 1px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); color: var(--text-2); }
.level-mid { color: var(--primary); border-color: currentColor; }
.level-high { color: var(--pending-fg); background: var(--pending-bg); border-color: var(--pending-border); }
.back { margin: 0 0 12px; }
.back a { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); text-decoration: none; font-size: 14px; }
.summary-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.task-id { font-size: 18px; margin: 0; word-break: break-all; }
.summary-grid, .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px 20px; margin: 16px 0 0; }
.summary-grid dt, .kv dt { font-size: 12px; color: var(--text-3); }
.summary-grid dd, .kv dd { margin: 2px 0 0; }
.card + .card, section + section { margin-top: 16px; }
.panel-title { font-size: 16px; margin: 0 0 8px; }
.panel-line { margin: 0 0 8px; }
.sub-title { font-size: 13px; margin: 12px 0 6px; color: var(--text-2); }
.code-block { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; white-space: pre-wrap; word-break: break-word; font-size: 13px; max-height: 360px; overflow: auto; }
.hash-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; word-break: break-all; }
.hash-details { margin-top: 12px; }
.note { color: var(--text-2); font-size: 13px; }
.decide { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: end; margin-top: 16px; }
.approve-form button[type="submit"] { display: inline-flex; align-items: center; gap: 6px; font: 600 15px/20px var(--font-sans); padding: 10px 22px; border-radius: var(--radius); border: 1px solid transparent; cursor: pointer; text-decoration: none; background: var(--primary); color: var(--primary-contrast); }
.approve-form button[type="submit"]:hover { background: var(--primary-hover); }
.reject-form button[type="submit"] { display: inline-flex; align-items: center; gap: 6px; font: 600 14px/20px var(--font-sans); padding: 8px 14px; border-radius: var(--radius); border: 1px solid var(--rejected-border); cursor: pointer; text-decoration: none; background: var(--surface); color: var(--rejected-fg); }
.field-label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
.reject-row { display: flex; gap: 8px; align-items: stretch; }
.reject-row textarea { flex: 1; min-height: 40px; font: inherit; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); resize: vertical; }
.help { color: var(--text-2); font-size: 13px; margin: 4px 0 0; }
.timeline { list-style: none; margin: 0; padding: 0; position: relative; }
.tl-item { position: relative; padding: 0 0 18px 28px; }
.tl-item::before { content: ""; position: absolute; left: 6px; top: 14px; bottom: 0; width: 2px; background: var(--border); }
.tl-item:last-child::before { display: none; }
.tl-dot { position: absolute; left: 0; top: 4px; width: 14px; height: 14px; border-radius: 50%; border: 3px solid var(--surface); box-shadow: 0 0 0 1px var(--border-strong); }
.tl-pending .tl-dot { background: var(--pending-fg); }
.tl-ok .tl-dot { background: var(--ok-fg); }
.tl-rejected .tl-dot { background: var(--rejected-fg); }
.tl-muted .tl-dot { background: var(--muted-fg); }
.tl-failed .tl-dot { background: var(--failed-fg); }
.tl-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.tl-time, .tl-actor { color: var(--text-3); font-size: 13px; margin: 0; }
.tl-detail { margin: 2px 0 0; color: var(--text-2); font-size: 14px; }
.tl-empty { color: var(--text-3); }
.raw { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-top: 8px; }
.raw summary { cursor: pointer; padding: 12px 16px; font-weight: 600; }
.raw[open] summary { border-bottom: 1px solid var(--border); }
.raw > :not(summary) { margin: 12px 16px; }
.notice-card { max-width: 560px; margin: 40px auto 0; text-align: center; }
.notice-icon { display: inline-flex; width: 56px; height: 56px; border-radius: 50%; align-items: center; justify-content: center; }
.tone-ok { background: var(--ok-bg); color: var(--ok-fg); }
.tone-danger { background: var(--rejected-bg); color: var(--rejected-fg); }
.tone-muted { background: var(--muted-bg); color: var(--muted-fg); }
.hash { word-break: break-all; }
.kv.center { justify-items: center; text-align: center; }
.error-explain { margin: 8px 0; }
.error-meta { color: var(--text-2); }
.error-message { color: var(--text-3); font-size: 13px; }
.error-code { font-weight: 700; }
@media (max-width: 560px) { .brand-sub { display: none; } }
@media (max-width: 640px) {
  .decide { grid-template-columns: 1fr; }
  .approve-form button[type="submit"] { width: 100%; justify-content: center; }
}
@media (min-width: 761px) {
  .tasks { table-layout: fixed; }
}
@media (max-width: 760px) {
  .tasks thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .tasks, .tasks tbody, .tasks tr, .tasks td { display: block; width: auto; }
  .tasks tr { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .tasks td { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; padding: 4px 0; border: 0; }
  .tasks td::before { content: attr(data-label); color: var(--text-3); font-size: 12px; flex: none; }
  .tasks .col-task { font-size: 15px; }
  .clip, .col-args .clip { max-width: 60vw; }
  .c-task, .c-action, .c-level, .c-state, .c-principal, .c-created, .c-expires, .c-args, .c-intent { width: auto; }
}
.login-card { max-width: 400px; margin: 40px auto 0; }
.login-form { display: grid; gap: 6px; margin-top: 16px; }
.login-form input { font: inherit; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); margin-bottom: 8px; }
.login-form button { justify-content: center; margin-top: 8px; }
`;

const STYLE = `[hidden]{display:none !important}\n${TOKENS_CSS}\n${CONSOLE_CSS}`;

export interface ListRow {
  id: string;
  type: string;
  level: string;
  state: string;
  principalId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  intent: string;
  args: string;
}

export interface TimelineRow {
  at: string;
  seq: number;
  label: string;
  actor: string;
  detail: string;
  tone: StatusTone;
}

export interface DecisionInfo {
  decision: "approved" | "rejected";
  approver: string;
  channel: string;
  assurance: string;
  simulated: boolean;
  decidedAt: string;
  noteRecorded: boolean;
}

export interface TaskPage {
  id: string;
  state: string;
  principalId: string;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  level: string;
  actionType: string;
  action: string;
  intent: string;
  payload: string;
  ruleId: string;
  result: string;
  minAssurance: string;
  stepUp: string;
  channels: string;
  payloadHash: string;
  pending: boolean;
  hints: string[];
  approveDisabled: boolean;
  rejectDisabled: boolean;
  csrf: string;
  args: string;
  allowEdit: boolean;
  approvedPayloadEdited: boolean;
  approvedPayloadHash: string;
  decisionInfo: DecisionInfo | null;
  timeline: TimelineRow[];
}

export interface LinkPage {
  id: string;
  state: string;
  action: string;
  intent: string;
  payload: string;
  ruleId: string;
  result: string;
  minAssurance: string;
  stepUp: string;
  channels: string;
  payloadHash: string;
  sig: string;
  exp: string;
  nonce: string;
}

type Tab = "pending" | "recent" | "all";

interface Frame {
  locale: Locale;
  title: string;
  bodyAttrs: Record<string, string>;
  langHrefs: { en: string; "zh-CN": string } | null;
  csrf: string | null;
  brandHref: string | null;
  script: boolean;
  i18n: Record<string, string> | null;
  variant: ConsoleVariant;
}

const I18N_STATES = [
  "prepared",
  "pending_approval",
  "approved",
  "executing",
  "executed",
  "failed",
  "unknown",
  "rejected",
  "drafted",
  "expired",
  "revoked",
] as const;

function consoleMessages(locale: Locale, variant: ConsoleVariant): Record<string, string> {
  const messages: Record<string, string> = {
    updated: t(locale, "list.updated"),
    "update-failed": t(locale, "list.updateFailed"),
    "session-ended": tv(locale, variant, "list.sessionEnded"),
    expires: t(locale, "time.expires"),
    expired: t(locale, "time.expired"),
    none: t(locale, "time.none"),
    copy: t(locale, "copy.label"),
    copied: t(locale, "copy.done"),
  };
  for (const state of I18N_STATES) {
    messages[`state-${state.replaceAll("_", "-")}`] = t(locale, `state.${state}`);
  }
  return messages;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function dataAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
    .join(" ");
}

function page(frame: Frame, main: string): string {
  const bodyAttrs = dataAttrs(frame.bodyAttrs);
  const brandInner = `${icon(ICON_BRAND, 22)}<span class="brand-name">${escapeHtml(t(frame.locale, "app.name"))}</span><span class="brand-sub">${escapeHtml(tv(frame.locale, frame.variant, "app.subtitle"))}</span>`;
  const brand = frame.brandHref
    ? `<a class="brand" href="${escapeHtml(frame.brandHref)}">${brandInner}</a>`
    : `<span class="brand">${brandInner}</span>`;
  const lang = frame.langHrefs
    ? `<nav class="lang-switch" aria-label="${escapeHtml(t(frame.locale, "app.language"))}"><a href="${escapeHtml(frame.langHrefs.en)}" lang="en" hreflang="en"${frame.locale === "en" ? ` aria-current="true"` : ""}>EN</a><a href="${escapeHtml(frame.langHrefs["zh-CN"])}" lang="zh-CN" hreflang="zh-CN"${frame.locale === "zh-CN" ? ` aria-current="true"` : ""}>中文</a></nav>`
    : "";
  const logout =
    frame.csrf !== null
      ? `<form class="logout-form" method="post" action="/logout">${hidden("csrf", frame.csrf)}<button type="submit" class="btn btn-ghost btn-sm">${escapeHtml(t(frame.locale, "app.logout"))}</button></form>`
      : "";
  const actions = lang || logout ? `<div class="header-actions">${lang}${logout}</div>` : "";
  const i18n =
    frame.i18n !== null ? `<div id="i18n" hidden ${dataAttrs(frame.i18n)}></div>` : "";
  const script = frame.script ? `<script src="/assets/console.js"></script>` : "";
  return `<!DOCTYPE html>
<html lang="${escapeHtml(frame.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(frame.title)} · ActLedger</title>
<style>${STYLE}</style>
</head>
<body data-locale="${escapeHtml(frame.locale)}"${bodyAttrs ? ` ${bodyAttrs}` : ""}>
<header class="app-header">
<div class="app-header-inner">
${brand}
${actions}
</div>
</header>
<main class="container">
${main}
</main>
<footer class="app-footer"><p>${icon(ICON_LOCK, 14)} ${escapeHtml(tv(frame.locale, frame.variant, "app.footer"))}</p></footer>
${i18n}
${script}
</body>
</html>
`;
}

function stateLabel(locale: Locale, state: string): string {
  const key = `state.${state}`;
  return isMessageKey(key) ? t(locale, key) : state;
}

function statusBadge(locale: Locale, state: string): string {
  return `<span class="status status-${statusTone(state)}" title="${escapeHtml(state)}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(stateLabel(locale, state))}</span>`;
}

function levelMarkup(level: string): string {
  if (!level) return "";
  return `<span class="level level-${LEVEL_TONE[level] ?? "low"}">${escapeHtml(level)}</span>`;
}

function relTime(iso: string): string {
  return `<time class="rel" datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`;
}

function absoluteTime(iso: string): string {
  return `<time class="abs" datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`;
}

function expiresMarkup(locale: Locale, expiresAt: string, expired: boolean, live: boolean): string {
  if (!expiresAt) return escapeHtml(t(locale, "time.none"));
  if (!live) return absoluteTime(expiresAt);
  const cls = expired ? "countdown is-expired" : "countdown";
  const text = expired ? t(locale, "time.expired") : expiresAt;
  return `<time class="${cls}" datetime="${escapeHtml(expiresAt)}" title="${escapeHtml(expiresAt)}">${escapeHtml(text)}</time>`;
}

function withTime(template: string, iso: string): string {
  const token = "{time}";
  const index = template.indexOf(token);
  if (index < 0) return escapeHtml(template);
  return `${escapeHtml(template.slice(0, index))}${relTime(iso)}${escapeHtml(template.slice(index + token.length))}`;
}

function copyButton(value: string, label: string): string {
  return `<button type="button" class="copy" data-copy="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon(ICON_COPY, 16, "i-copy")}${icon(ICON_CHECK, 16, "i-check")}</button>`;
}

function submitButton(label: string, disabled: boolean): string {
  return `<button type="submit"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
}

function noneOr(locale: Locale, value: string): string {
  return value ? escapeHtml(value) : escapeHtml(t(locale, "time.none"));
}

function tech(name: string, value: string, code: boolean): string {
  const body = code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value);
  return `<div><dt>${name}</dt><dd>${body}</dd></div>`;
}

function emphasizeCommand(text: string): string {
  const command = "actledger serve --print-login";
  const index = text.indexOf(command);
  if (index < 0) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, index))}<code>${escapeHtml(command)}</code>${escapeHtml(text.slice(index + command.length))}`;
}

function jsonActionType(actionJson: string): string {
  try {
    const parsed = JSON.parse(actionJson) as { type?: unknown };
    if (typeof parsed.type === "string") return parsed.type;
  } catch {
    // Display JSON is produced by the server.
  }
  return "";
}

export function renderList(
  locale: Locale,
  input: { tab: Tab; rows: ListRow[]; csrf: string; counts: Record<Tab, number>; now: string; variant?: ConsoleVariant },
): string {
  const variant = input.variant ?? "local";
  const tab = input.tab;
  const cols = {
    task: t(locale, "list.col.task"),
    action: t(locale, "list.col.action"),
    level: t(locale, "list.col.level"),
    state: t(locale, "list.col.state"),
    principal: t(locale, "list.col.principal"),
    created: t(locale, "list.col.created"),
    expires: t(locale, "list.col.expires"),
    args: t(locale, "list.col.args"),
    intent: t(locale, "list.col.intent"),
  };
  const rows = input.rows
    .map((row) => {
      const level = row.level ? levelMarkup(row.level) : escapeHtml(t(locale, "time.none"));
      return `<tr class="task-row" data-state="${escapeHtml(row.state)}">
<td class="col-task" data-label="${escapeHtml(cols.task)}"><a class="task-link mono" href="/tasks/${encodeURIComponent(row.id)}" title="${escapeHtml(row.id)}">${escapeHtml(row.id)}</a></td>
<td class="col-action" data-label="${escapeHtml(cols.action)}"><code>${escapeHtml(row.type)}</code></td>
<td class="col-level" data-label="${escapeHtml(cols.level)}">${level}</td>
<td class="col-state" data-label="${escapeHtml(cols.state)}">${statusBadge(locale, row.state)}</td>
<td class="col-principal" data-label="${escapeHtml(cols.principal)}">${escapeHtml(row.principalId)}</td>
<td class="col-created" data-label="${escapeHtml(cols.created)}">${relTime(row.createdAt)}</td>
<td class="col-expires" data-label="${escapeHtml(cols.expires)}">${expiresMarkup(locale, row.expiresAt, row.expired, row.state === "pending_approval")}</td>
<td class="col-args" data-label="${escapeHtml(cols.args)}"><span class="clip mono" title="${escapeHtml(row.args)}">${escapeHtml(row.args)}</span></td>
<td class="col-intent" data-label="${escapeHtml(cols.intent)}"><span class="clip" title="${escapeHtml(row.intent)}">${escapeHtml(row.intent)}</span></td>
</tr>`;
    })
    .join("\n");
  const emptyLink =
    tab === "pending"
      ? `<a class="btn btn-secondary btn-sm" href="/?tab=recent">${escapeHtml(t(locale, "list.empty.pending.link"))}</a>`
      : tab === "recent"
        ? `<a class="btn btn-secondary btn-sm" href="/?tab=all">${escapeHtml(t(locale, "list.empty.recent.link"))}</a>`
        : "";
  const titleKey = `list.title.${tab}` as MessageKey;
  const emptyTitle = `list.empty.${tab}.title` as MessageKey;
  const emptyHint = `list.empty.${tab}.hint` as MessageKey;
  const main = `<div class="page-head">
<h1 class="page-title">${escapeHtml(t(locale, titleKey))}</h1>
<p class="updated" id="updated-at" aria-live="polite"><span class="live-dot" aria-hidden="true"></span><span id="updated-text">${withTime(t(locale, "list.updated"), input.now)}</span></p>
</div>
<div class="banner callout callout-danger" id="session-banner" role="alert" hidden>${icon(ICON_ALERT, 20)}<span>${escapeHtml(tv(locale, variant, "list.sessionEnded"))}</span></div>
<nav class="tabs" aria-label="${escapeHtml(t(locale, "list.tabs"))}">
<a class="tab" href="/?tab=pending"${tab === "pending" ? ` aria-current="page"` : ""}><span class="tab-label">${escapeHtml(t(locale, "list.tab.pending"))}</span><span class="tab-count" data-count-for="pending">${input.counts.pending}</span></a>
<a class="tab" href="/?tab=recent"${tab === "recent" ? ` aria-current="page"` : ""}><span class="tab-label">${escapeHtml(t(locale, "list.tab.recent"))}</span><span class="tab-count" data-count-for="recent">${input.counts.recent}</span></a>
<a class="tab" href="/?tab=all"${tab === "all" ? ` aria-current="page"` : ""}><span class="tab-label">${escapeHtml(t(locale, "list.tab.all"))}</span><span class="tab-count" data-count-for="all">${input.counts.all}</span></a>
</nav>
<section class="card list-card">
<div class="table-scroll">
<table class="tasks" id="task-table"${input.rows.length === 0 ? " hidden" : ""}>
<colgroup><col class="c-task"><col class="c-action"><col class="c-level"><col class="c-state"><col class="c-principal"><col class="c-created"><col class="c-expires"><col class="c-args"><col class="c-intent"></colgroup>
<thead><tr><th scope="col">${escapeHtml(cols.task)}</th><th scope="col">${escapeHtml(cols.action)}</th><th scope="col">${escapeHtml(cols.level)}</th><th scope="col">${escapeHtml(cols.state)}</th><th scope="col">${escapeHtml(cols.principal)}</th><th scope="col">${escapeHtml(cols.created)}</th><th scope="col">${escapeHtml(cols.expires)}</th><th scope="col">${escapeHtml(cols.args)}</th><th scope="col">${escapeHtml(cols.intent)}</th></tr></thead>
<tbody id="task-rows">
${rows}
</tbody>
</table>
</div>
<div class="empty" id="empty-state"${input.rows.length === 0 ? "" : " hidden"}>
<span class="empty-icon">${icon(ICON_INBOX, 28)}</span>
<h2 class="empty-title">${escapeHtml(t(locale, emptyTitle))}</h2>
<p class="empty-hint">${escapeHtml(tv(locale, variant, emptyHint))}</p>
${emptyLink}
</div>
</section>`;
  return page(
    {
      locale,
      title: t(locale, titleKey),
      bodyAttrs: { page: "list", tab, now: input.now },
      langHrefs: { en: `/?tab=${tab}&lang=en`, "zh-CN": `/?tab=${tab}&lang=zh-CN` },
      csrf: input.csrf,
      brandHref: "/",
      script: true,
      i18n: consoleMessages(locale, variant),
      variant,
    },
    main,
  );
}

function decisionHtml(locale: Locale, info: DecisionInfo): string {
  const helpKey = `assurance.${info.assurance}`;
  const help = isMessageKey(helpKey) ? `<p class="help">${escapeHtml(t(locale, helpKey))}</p>` : "";
  return `<section class="card decision-card">
<h2 class="panel-title">${escapeHtml(t(locale, "detail.decision"))}</h2>
<dl class="kv">
<div><dt>${escapeHtml(t(locale, "detail.decision.result"))}</dt><dd>${statusBadge(locale, info.decision)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.decision.approver"))}</dt><dd>${escapeHtml(info.approver)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.decision.channel"))}</dt><dd><code>${escapeHtml(info.channel)}</code></dd></div>
<div><dt>${escapeHtml(t(locale, "detail.decision.assurance"))}</dt><dd><code>${escapeHtml(info.assurance)}</code>${help}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.decision.simulated"))}</dt><dd>${escapeHtml(t(locale, info.simulated ? "detail.yes" : "detail.no"))}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.decision.decidedAt"))}</dt><dd>${relTime(info.decidedAt)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.decision.reason"))}</dt><dd>${escapeHtml(t(locale, info.noteRecorded ? "detail.reasonRecorded" : "detail.reasonNone"))}</dd></div>
</dl>
</section>`;
}

function timelineHtml(locale: Locale, rows: TimelineRow[]): string {
  const items =
    rows.length === 0
      ? `<li class="tl-empty">${escapeHtml(t(locale, "detail.timelineEmpty"))}</li>`
      : rows
          .map(
            (row) => `<li class="tl-item tl-${row.tone}">
<span class="tl-dot" aria-hidden="true"></span>
<div class="tl-body">
<div class="tl-head"><strong class="tl-label">${escapeHtml(row.label)}</strong><time class="rel tl-time" datetime="${escapeHtml(row.at)}" title="${escapeHtml(row.at)}">${escapeHtml(row.at)}</time></div>
<p class="tl-actor mono">${escapeHtml(row.actor)}</p>
${row.detail ? `<p class="tl-detail">${escapeHtml(row.detail)}</p>` : ""}
</div>
</li>`,
          )
          .join("\n");
  return `<section class="card timeline-card">
<h2 class="panel-title">${escapeHtml(t(locale, "detail.timeline"))}</h2>
<ol class="timeline">
${items}
</ol>
</section>`;
}

function detailRaw(locale: Locale, task: TaskPage): string {
  const edited = !task.pending && task.approvedPayloadEdited;
  const title = edited ? t(locale, "detail.raw.payloadEdited") : t(locale, "detail.raw.payload");
  const approved = edited
    ? `<p>approved_payload_hash <code>${escapeHtml(task.approvedPayloadHash)}</code></p>`
    : "";
  return `<section class="raw-sections">
<details class="raw"><summary>${escapeHtml(t(locale, "detail.raw.action"))}</summary><pre class="code-block">${escapeHtml(task.action)}</pre></details>
<details class="raw"><summary>${escapeHtml(t(locale, "detail.raw.intent"))}</summary><pre class="code-block">${escapeHtml(task.intent)}</pre></details>
<details class="raw"><summary>${escapeHtml(title)}</summary><pre class="code-block">${escapeHtml(task.payload)}</pre>${approved}</details>
<details class="raw"><summary>${escapeHtml(t(locale, "detail.raw.policy"))}</summary>
<dl class="kv tech">
${tech("state", task.state, true)}
${tech("principalId", task.principalId, false)}
${tech("agentId", task.agentId, false)}
${tech("createdAt", task.createdAt, false)}
${tech("expiresAt", task.expiresAt, false)}
${tech("ruleId", task.ruleId, false)}
${tech("result", task.result, false)}
${tech("minAssurance", task.minAssurance, false)}
${tech("stepUp", task.stepUp, false)}
${tech("channels", task.channels, false)}
${tech("payload_hash", task.payloadHash, true)}
</dl>
</details>
</section>`;
}

function approvalPanel(
  locale: Locale,
  options: {
    actionType: string;
    bodyLabel: string;
    body: string;
    payloadHash: string;
    copyHash: boolean;
    editNote: string;
    hints: string[];
    approveDisabled: boolean;
    rejectDisabled: boolean;
    approveAction: string;
    rejectAction: string;
    approveHidden: string;
    rejectHidden: string;
  },
): string {
  const hashButton = options.copyHash ? copyButton(options.payloadHash, t(locale, "detail.copyHash")) : "";
  const note = options.editNote ? `<p class="note">${escapeHtml(options.editNote)}</p>` : "";
  const hints =
    options.hints.length === 0
      ? ""
      : `<div class="callout callout-warn" id="approve-blocked" role="note">${icon(ICON_ALERT, 20)}<div><p class="callout-title">${escapeHtml(t(locale, "detail.blockedTitle"))}</p>${options.hints.map((hint) => `<p>${escapeHtml(hint)}</p>`).join("")}</div></div>`;
  return `<section class="card approval-panel" aria-labelledby="approve-title">
<h2 class="panel-title" id="approve-title">${escapeHtml(t(locale, "detail.approving"))}</h2>
<p class="panel-line">${escapeHtml(t(locale, "detail.actionLine"))} <code>${escapeHtml(options.actionType)}</code></p>
<h3 class="sub-title">${escapeHtml(options.bodyLabel)}</h3>
<pre class="code-block">${escapeHtml(options.body)}</pre>
<details class="hash-details">
<summary>${escapeHtml(t(locale, "detail.hashSummary"))}</summary>
<p class="hash-row">presented_hash <code>${escapeHtml(options.payloadHash)}</code>${hashButton}</p>
</details>
${note}
${hints}
<div class="decide">
<form class="approve-form" method="post" action="${escapeHtml(options.approveAction)}">
${options.approveHidden}
${submitButton(t(locale, "detail.approve"), options.approveDisabled)}
</form>
<form class="reject-form" method="post" action="${escapeHtml(options.rejectAction)}">
${options.rejectHidden}
<label class="field-label" for="reject-reason">${escapeHtml(t(locale, "detail.reasonLabel"))}</label>
<div class="reject-row">
<textarea id="reject-reason" name="reason" required maxlength="2000" rows="2" placeholder="${escapeHtml(t(locale, "detail.reasonPlaceholder"))}"></textarea>
${submitButton(t(locale, "detail.reject"), options.rejectDisabled)}
</div>
</form>
</div>
</section>`;
}

export function renderDetail(locale: Locale, task: TaskPage, now: string, variant: ConsoleVariant = "local"): string {
  const level = task.level ? levelMarkup(task.level) : escapeHtml(t(locale, "time.none"));
  const summary = `<section class="card task-summary">
<div class="summary-top">
<h1 class="task-id mono">${escapeHtml(task.id)}</h1>
${copyButton(task.id, t(locale, "detail.copyId"))}
${statusBadge(locale, task.state)}
</div>
<dl class="summary-grid">
<div><dt>${escapeHtml(t(locale, "detail.field.action"))}</dt><dd><code>${escapeHtml(task.actionType)}</code></dd></div>
<div><dt>${escapeHtml(t(locale, "detail.field.level"))}</dt><dd>${level}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.field.principal"))}</dt><dd>${escapeHtml(task.principalId)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.field.agent"))}</dt><dd>${noneOr(locale, task.agentId)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.field.created"))}</dt><dd>${relTime(task.createdAt)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.field.expires"))}</dt><dd>${expiresMarkup(locale, task.expiresAt, task.expired, task.pending)}</dd></div>
<div><dt>${escapeHtml(t(locale, "detail.field.rule"))}</dt><dd><code>${escapeHtml(task.ruleId)}</code></dd></div>
</dl>
</section>`;
  const fields = `${hidden("csrf", task.csrf)}\n${hidden("presented_hash", task.payloadHash)}`;
  const panel = task.pending
    ? approvalPanel(locale, {
        actionType: task.actionType,
        bodyLabel: t(locale, "detail.args"),
        body: task.args,
        payloadHash: task.payloadHash,
        copyHash: true,
        editNote: task.allowEdit ? tv(locale, variant, "detail.editNote", { id: task.id }) : "",
        hints: task.hints,
        approveDisabled: task.approveDisabled,
        rejectDisabled: task.rejectDisabled,
        approveAction: `/tasks/${encodeURIComponent(task.id)}/approve`,
        rejectAction: `/tasks/${encodeURIComponent(task.id)}/reject`,
        approveHidden: fields,
        rejectHidden: fields,
      })
    : `<p class="callout callout-muted">${escapeHtml(t(locale, "detail.closed"))}</p>`;
  const main = `<p class="back"><a href="/">${icon(ICON_BACK, 16)}${escapeHtml(t(locale, "app.back"))}</a></p>
${summary}
${panel}
${task.decisionInfo ? decisionHtml(locale, task.decisionInfo) : ""}
${timelineHtml(locale, task.timeline)}
${detailRaw(locale, task)}`;
  return page(
    {
      locale,
      title: task.id,
      bodyAttrs: { page: "detail", now },
      langHrefs: {
        en: `/tasks/${encodeURIComponent(task.id)}?lang=en`,
        "zh-CN": `/tasks/${encodeURIComponent(task.id)}?lang=zh-CN`,
      },
      csrf: task.csrf,
      brandHref: "/",
      script: true,
      i18n: consoleMessages(locale, variant),
      variant,
    },
    main,
  );
}

function linkLangHrefs(page: LinkPage): { en: string; "zh-CN": string } {
  const base = `/t/${encodeURIComponent(page.id)}`;
  return {
    en: `${base}?${new URLSearchParams({ sig: page.sig, exp: page.exp, lang: "en" }).toString()}`,
    "zh-CN": `${base}?${new URLSearchParams({ sig: page.sig, exp: page.exp, lang: "zh-CN" }).toString()}`,
  };
}

function linkFields(page: LinkPage, decision: "approve" | "reject"): string {
  return `${hidden("sig", page.sig)}
${hidden("exp", page.exp)}
${hidden("nonce", page.nonce)}
${hidden("presented_hash", page.payloadHash)}
${hidden("decision", decision)}`;
}

export function renderLink(locale: Locale, pageInput: LinkPage): string {
  const action = `/t/${encodeURIComponent(pageInput.id)}`;
  const summary = `<section class="card task-summary">
<div class="summary-top">
<h1 class="task-id mono">${escapeHtml(pageInput.id)}</h1>
${statusBadge(locale, pageInput.state)}
</div>
<p class="panel-line">${escapeHtml(t(locale, "link.intro"))}</p>
</section>`;
  const panel = approvalPanel(locale, {
    actionType: jsonActionType(pageInput.action),
    bodyLabel: t(locale, "detail.args"),
    body: pageInput.payload,
    payloadHash: pageInput.payloadHash,
    copyHash: false,
    editNote: "",
    hints: [],
    approveDisabled: false,
    rejectDisabled: false,
    approveAction: action,
    rejectAction: action,
    approveHidden: linkFields(pageInput, "approve"),
    rejectHidden: linkFields(pageInput, "reject"),
  });
  const raw = `<section class="raw-sections">
<details class="raw"><summary>${escapeHtml(t(locale, "detail.raw.action"))}</summary><pre class="code-block">${escapeHtml(pageInput.action)}</pre></details>
<details class="raw"><summary>${escapeHtml(t(locale, "detail.raw.intent"))}</summary><pre class="code-block">${escapeHtml(pageInput.intent)}</pre></details>
<details class="raw"><summary>${escapeHtml(t(locale, "detail.raw.policy"))}</summary>
<dl class="kv tech">
${tech("state", pageInput.state, true)}
${tech("ruleId", pageInput.ruleId, false)}
${tech("result", pageInput.result, false)}
${tech("minAssurance", pageInput.minAssurance, false)}
${tech("stepUp", pageInput.stepUp, false)}
${tech("channels", pageInput.channels, false)}
${tech("payload_hash", pageInput.payloadHash, true)}
</dl>
</details>
</section>`;
  return page(
    {
      locale,
      title: pageInput.id,
      bodyAttrs: { page: "link" },
      langHrefs: linkLangHrefs(pageInput),
      csrf: null,
      brandHref: null,
      script: false,
      i18n: null,
      variant: "local",
    },
    `${summary}\n${panel}\n${raw}`,
  );
}

export function renderLinkStatus(locale: Locale, id: string, state: string | null): string {
  const body = !state
    ? `<section class="card notice-card"><h1 class="page-title">${escapeHtml(t(locale, "linkStatus.title"))}</h1><p>${escapeHtml(t(locale, "linkStatus.missing"))}</p></section>`
    : `<section class="card notice-card"><h1 class="page-title">${escapeHtml(t(locale, "linkStatus.title"))}</h1><p class="mono">${escapeHtml(id)}</p><p>${escapeHtml(t(locale, "linkStatus.state"))} ${statusBadge(locale, state)}</p></section>`;
  return page(
    {
      locale,
      title: t(locale, "linkStatus.title"),
      bodyAttrs: { page: "link-status" },
      langHrefs: null,
      csrf: null,
      brandHref: null,
      script: false,
      i18n: null,
      variant: "local",
    },
    body,
  );
}

export function renderResult(locale: Locale, id: string, state: string, receiptHash: string): string {
  const body = `<section class="card notice-card">
<span class="notice-icon tone-ok">${icon(ICON_CHECK, 28)}</span>
<h1 class="page-title">${escapeHtml(t(locale, "result.title"))}</h1>
<dl class="kv center">
<div><dt>${escapeHtml(t(locale, "result.task"))}</dt><dd class="mono">${escapeHtml(id)}</dd></div>
<div><dt>${escapeHtml(t(locale, "result.state"))}</dt><dd>${statusBadge(locale, state)}</dd></div>
<div><dt>${escapeHtml(t(locale, "result.receipt"))}</dt><dd><code class="hash">${escapeHtml(receiptHash)}</code></dd></div>
</dl>
<p class="help">${escapeHtml(t(locale, "result.close"))}</p>
</section>`;
  return page(
    {
      locale,
      title: t(locale, "result.title"),
      bodyAttrs: { page: "result" },
      langHrefs: null,
      csrf: null,
      brandHref: null,
      script: false,
      i18n: null,
      variant: "local",
    },
    body,
  );
}

export function renderLoginEnded(locale: Locale, variant: ConsoleVariant = "local"): string {
  const body =
    variant === "remote"
      ? `<section class="card notice-card">
<span class="notice-icon tone-muted">${icon(ICON_LOCK, 28)}</span>
<h1 class="page-title">${escapeHtml(t(locale, "loginEnded.title"))}</h1>
<p>${escapeHtml(tv(locale, "remote", "loginEnded.body"))}</p>
<p><a class="btn btn-primary btn-sm" href="/login">${escapeHtml(t(locale, "login.again"))}</a></p>
</section>`
      : `<section class="card notice-card">
<span class="notice-icon tone-muted">${icon(ICON_LOCK, 28)}</span>
<h1 class="page-title">${escapeHtml(t(locale, "loginEnded.title"))}</h1>
<p>${emphasizeCommand(t(locale, "loginEnded.body"))}</p>
</section>`;
  return page(
    {
      locale,
      title: t(locale, "loginEnded.docTitle"),
      bodyAttrs: { page: "login-ended" },
      langHrefs: { en: "/login-ended?lang=en", "zh-CN": "/login-ended?lang=zh-CN" },
      csrf: null,
      brandHref: null,
      script: false,
      i18n: null,
      variant,
    },
    body,
  );
}

export function renderLogin(
  locale: Locale,
  input: { error: "login.failed" | "login.limited" | null; username: string },
): string {
  const error = input.error
    ? `<div class="callout callout-danger" role="alert">${icon(ICON_ALERT, 20)}<span>${escapeHtml(t(locale, input.error))}</span></div>`
    : "";
  const body = `<section class="card login-card">
<h1 class="page-title">${escapeHtml(t(locale, "login.title"))}</h1>
${error}
<form class="login-form" method="post" action="/login">
<label class="field-label" for="username">${escapeHtml(t(locale, "login.username"))}</label>
<input id="username" name="username" autocomplete="username" required maxlength="64" value="${escapeHtml(input.username)}">
<label class="field-label" for="password">${escapeHtml(t(locale, "login.password"))}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
<label class="field-label" for="totp">${escapeHtml(t(locale, "login.totp"))}</label>
<input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required maxlength="7">
<button type="submit" class="btn btn-primary">${escapeHtml(t(locale, "login.submit"))}</button>
</form>
</section>`;
  return page(
    {
      locale,
      title: t(locale, "login.docTitle"),
      bodyAttrs: { page: "login" },
      langHrefs: { en: "/login?lang=en", "zh-CN": "/login?lang=zh-CN" },
      csrf: null,
      brandHref: null,
      script: false,
      i18n: null,
      variant: "remote",
    },
    body,
  );
}

export function renderError(locale: Locale, code: string, message: string, variant: ConsoleVariant = "local"): string {
  const key = `error.explain.${code}`;
  const explain = isMessageKey(key) ? `<p class="error-explain">${escapeHtml(t(locale, key))}</p>` : "";
  const body = `<section class="card notice-card error-card">
<span class="notice-icon tone-danger">${icon(ICON_ALERT, 28)}</span>
<h1 class="page-title">${escapeHtml(t(locale, "error.title"))}</h1>
${explain}
<p class="error-meta">${escapeHtml(t(locale, "error.code"))} <code class="error-code">${escapeHtml(code)}</code></p>
<p class="error-message">${escapeHtml(message)}</p>
<p><a class="btn btn-secondary btn-sm" href="/">${escapeHtml(t(locale, "error.back"))}</a></p>
</section>`;
  return page(
    {
      locale,
      title: t(locale, "error.docTitle"),
      bodyAttrs: { page: "error" },
      langHrefs: null,
      csrf: null,
      brandHref: null,
      script: false,
      i18n: null,
      variant,
    },
    body,
  );
}
