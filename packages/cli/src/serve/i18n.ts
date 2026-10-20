import type http from "node:http";
import { parseCookies } from "./auth.js";

export type Locale = "en" | "zh-CN";
export const LANG_COOKIE = "actledger_lang";

const EN = {
  "app.name": "ActLedger",
  "app.subtitle": "Local approval console",
  "app.footer":
    "Listening on 127.0.0.1 only. Every decision is written to the local ledger as a signed receipt.",
  "app.logout": "Log out",
  "app.language": "Language",
  "app.back": "Back to the list",
  "copy.label": "Copy",
  "copy.done": "Copied",
  "time.expires": "Expires {rel}",
  "time.expired": "expired",
  "time.none": "—",
  "state.prepared": "Prepared",
  "state.pending_approval": "Pending approval",
  "state.approved": "Approved",
  "state.executing": "Executing",
  "state.executed": "Executed",
  "state.failed": "Failed",
  "state.unknown": "Unknown",
  "state.rejected": "Rejected",
  "state.drafted": "Drafted",
  "state.expired": "Expired",
  "state.revoked": "Revoked",
  "list.title.pending": "Pending approvals",
  "list.title.recent": "Recent decisions",
  "list.title.all": "All tasks",
  "list.tab.pending": "Pending",
  "list.tab.recent": "Recent",
  "list.tab.all": "All",
  "list.tabs": "Task lists",
  "list.col.task": "Task",
  "list.col.action": "Action",
  "list.col.level": "Level",
  "list.col.state": "State",
  "list.col.principal": "Principal",
  "list.col.created": "Created",
  "list.col.expires": "Expires",
  "list.col.args": "Args",
  "list.col.intent": "Intent",
  "list.updated": "Updated {time}",
  "list.updateFailed": "Update failed; retrying.",
  "list.sessionEnded": "Session ended. Run actledger serve --print-login and open the URL again.",
  "list.empty.pending.title": "Nothing is waiting for approval",
  "list.empty.pending.hint": "When an agent calls a tool that needs approval, it shows up here.",
  "list.empty.pending.link": "See recent decisions",
  "list.empty.recent.title": "No decisions yet",
  "list.empty.recent.hint": "Approvals and rejections made here, in the CLI, or from a link show up here.",
  "list.empty.recent.link": "See all tasks",
  "list.empty.all.title": "No tasks yet",
  "list.empty.all.hint": "Tasks appear once an agent asks to run an action through ActLedger.",
  "detail.copyId": "Copy task id",
  "detail.field.action": "Action",
  "detail.field.level": "Level",
  "detail.field.principal": "Principal",
  "detail.field.agent": "Agent",
  "detail.field.created": "Created",
  "detail.field.expires": "Expires",
  "detail.field.rule": "Policy rule",
  "detail.approving": "You are approving",
  "detail.actionLine": "action",
  "detail.args": "args",
  "detail.hashSummary": "Hash of what you see",
  "detail.copyHash": "Copy hash",
  "detail.approve": "Approve",
  "detail.reject": "Reject",
  "detail.reasonLabel": "Reason (required)",
  "detail.reasonPlaceholder": "Why are you rejecting this?",
  "detail.blockedTitle": "Why you cannot approve here",
  "detail.editNote":
    "Editing before approval is only available in the CLI (actledger approve {id} --edit file.json). This page approves the payload exactly as shown.",
  "detail.closed": "This task is no longer waiting for approval.",
  "detail.decision": "Decision",
  "detail.decision.result": "Decision",
  "detail.decision.approver": "Approver",
  "detail.decision.channel": "Channel",
  "detail.decision.assurance": "Assurance",
  "detail.decision.simulated": "Simulated",
  "detail.decision.decidedAt": "Decided",
  "detail.decision.reason": "Reason",
  "detail.yes": "yes",
  "detail.no": "no",
  "detail.reasonRecorded": "recorded",
  "detail.reasonNone": "none",
  "assurance.policy": "A policy rule decided this automatically; nobody was asked.",
  "assurance.app_asserted":
    "The app vouches for who decided (this console or the CLI). No channel verified the person.",
  "assurance.channel_verified": "A verified channel confirmed who decided.",
  "assurance.user_signed": "The approver signed the decision with their own key.",
  "detail.timeline": "Timeline",
  "detail.timelineEmpty": "(timeline unavailable)",
  "detail.raw.action": "Action",
  "detail.raw.intent": "Intent",
  "detail.raw.payload": "Payload",
  "detail.raw.payloadEdited": "Approved payload (edited before approval)",
  "detail.raw.policy": "Policy and hashes",
  "tl.requested": "requested",
  "tl.pending": "pending approval",
  "tl.approvedPolicy": "approved by policy",
  "tl.approved": "approved",
  "tl.deniedPolicy": "denied by policy",
  "tl.rejected": "rejected",
  "tl.drafted": "drafted",
  "tl.claimed": "claimed",
  "tl.completed": "completed",
  "tl.failed": "failed",
  "tl.unknown": "unknown",
  "tl.expired": "expired",
  "tl.revoked": "revoked",
  "tl.rule": "rule {rule}",
  "tl.approval": "by {approver} · channel {channel} · assurance {assurance}",
  "tl.simulated": " · simulated",
  "tl.reasonRecorded": " · reason recorded",
  "tl.reason": "reason {reason}",
  "tl.error": "error {code}",
  "hint.channel": "This policy does not allow approving on this page. Use `actledger approve`.",
  "hint.assurance":
    "Approve is disabled: this action needs {min} assurance, and this page can only record app_asserted. Approve it with the CLI (actledger approve {id} --assurance {min}) or a verified channel. You can still reject it here with a reason.",
  "hint.stepUp":
    "Approve is disabled: this action needs step-up {stepUp}, which this page cannot collect. Use the CLI (actledger approve {id} --step-up).",
  "hint.approver": "The approver set for this console does not match the task's principal.",
  "link.intro": "This page records one decision for this task. The link stops working after you use it.",
  "linkStatus.title": "Task",
  "linkStatus.missing": "This task does not exist.",
  "linkStatus.state": "Current state",
  "result.title": "Decision recorded",
  "result.task": "Task",
  "result.state": "State",
  "result.receipt": "Receipt",
  "result.close": "You can close this page.",
  "loginEnded.docTitle": "Logged out",
  "loginEnded.title": "You are logged out",
  "loginEnded.body":
    "Your session on this console has ended. To log in again, run actledger serve --print-login and open the URL it prints.",
  "error.docTitle": "Error",
  "error.title": "Something went wrong",
  "error.code": "Error code",
  "error.back": "Back to the console",
  "error.explain.reason_required": "A rejection needs a reason. Go back and fill in the reason.",
  "error.explain.origin_rejected": "The request did not come from this console's page, so it was refused.",
  "error.explain.fetch_site_rejected": "The browser marked this as a cross-site request, so it was refused.",
  "error.explain.csrf_failed": "The form is out of date. Reload the page and try again.",
  "error.explain.not_found": "This task does not exist.",
  "error.explain.invalid_request": "The request was not valid.",
  "error.explain.invalid_transition": "The task is no longer in a state that allows this decision.",
  "error.explain.task_expired": "The approval window for this task has closed.",
  "error.explain.presented_hash_mismatch": "The task changed after this page was shown. Reload and review it again.",
  "error.explain.channel_not_allowed": "The policy does not allow deciding this task here.",
  "error.explain.approver_mismatch": "You are not the approver for this task.",
  "error.explain.assurance_insufficient": "This task needs a stronger approval than this page can record.",
  "error.explain.step_up_required": "This task needs a step-up check that this page cannot do.",
  "error.explain.bad_signature": "This approval link is not valid.",
  "error.explain.link_expired": "This approval link has expired.",
  "error.explain.link_used": "This approval link has already been used.",
  "error.explain.nonce_failed": "The form is out of date. Open the link again.",
} as const;

export type MessageKey = keyof typeof EN;

const ZH_CN: Record<MessageKey, string> = {
  "app.name": "ActLedger",
  "app.subtitle": "本地审批台",
  "app.footer": "只监听 127.0.0.1。每个决定都会作为签名回执写入本地账本。",
  "app.logout": "退出登录",
  "app.language": "语言",
  "app.back": "返回列表",
  "copy.label": "复制",
  "copy.done": "已复制",
  "time.expires": "{rel}过期",
  "time.expired": "已超时",
  "time.none": "—",
  "state.prepared": "已准备",
  "state.pending_approval": "待审批",
  "state.approved": "已批准",
  "state.executing": "执行中",
  "state.executed": "已执行",
  "state.failed": "失败",
  "state.unknown": "结果未知",
  "state.rejected": "已拒绝",
  "state.drafted": "已存草稿",
  "state.expired": "已过期",
  "state.revoked": "已撤销",
  "list.title.pending": "待审批的操作",
  "list.title.recent": "最近的决定",
  "list.title.all": "全部任务",
  "list.tab.pending": "待审批",
  "list.tab.recent": "最近决定",
  "list.tab.all": "全部",
  "list.tabs": "任务列表",
  "list.col.task": "任务",
  "list.col.action": "动作",
  "list.col.level": "级别",
  "list.col.state": "状态",
  "list.col.principal": "主体",
  "list.col.created": "创建",
  "list.col.expires": "过期",
  "list.col.args": "参数",
  "list.col.intent": "意图",
  "list.updated": "更新于 {time}",
  "list.updateFailed": "更新失败，正在重试。",
  "list.sessionEnded": "会话已结束。运行 actledger serve --print-login，再打开打印出的链接。",
  "list.empty.pending.title": "目前没有等待审批的操作",
  "list.empty.pending.hint": "agent 调用需要审批的工具时会出现在这里。",
  "list.empty.pending.link": "查看最近的决定",
  "list.empty.recent.title": "还没有人工决定",
  "list.empty.recent.hint": "在这里、CLI 或审批链接里做出的批准和拒绝会显示在这里。",
  "list.empty.recent.link": "查看全部任务",
  "list.empty.all.title": "还没有任务",
  "list.empty.all.hint": "agent 通过 ActLedger 请求执行操作后，任务会出现在这里。",
  "detail.copyId": "复制任务 id",
  "detail.field.action": "动作",
  "detail.field.level": "级别",
  "detail.field.principal": "主体",
  "detail.field.agent": "Agent",
  "detail.field.created": "创建于",
  "detail.field.expires": "过期",
  "detail.field.rule": "策略规则",
  "detail.approving": "你正在批准",
  "detail.actionLine": "动作",
  "detail.args": "参数",
  "detail.hashSummary": "你看到的内容的哈希",
  "detail.copyHash": "复制哈希",
  "detail.approve": "批准",
  "detail.reject": "拒绝",
  "detail.reasonLabel": "理由（必填）",
  "detail.reasonPlaceholder": "为什么拒绝？",
  "detail.blockedTitle": "为什么这里不能批准",
  "detail.editNote":
    "批准前修改内容只能在 CLI 里做（actledger approve {id} --edit file.json）。本页按显示的内容原样批准。",
  "detail.closed": "这个任务已不再等待审批。",
  "detail.decision": "决定",
  "detail.decision.result": "结果",
  "detail.decision.approver": "审批人",
  "detail.decision.channel": "渠道",
  "detail.decision.assurance": "确认级别",
  "detail.decision.simulated": "模拟",
  "detail.decision.decidedAt": "决定时间",
  "detail.decision.reason": "理由",
  "detail.yes": "是",
  "detail.no": "否",
  "detail.reasonRecorded": "已记录",
  "detail.reasonNone": "无",
  "assurance.policy": "由策略规则自动决定，没有询问任何人。",
  "assurance.app_asserted": "由应用担保是谁做的决定（本审批台或 CLI），没有渠道验证这个人。",
  "assurance.channel_verified": "已验证的渠道确认了做决定的人。",
  "assurance.user_signed": "审批人用自己的密钥签署了这个决定。",
  "detail.timeline": "时间线",
  "detail.timelineEmpty": "（时间线不可用）",
  "detail.raw.action": "动作（原始）",
  "detail.raw.intent": "意图",
  "detail.raw.payload": "Payload",
  "detail.raw.payloadEdited": "批准的 payload（批准前已修改）",
  "detail.raw.policy": "策略与哈希",
  "tl.requested": "已请求",
  "tl.pending": "等待审批",
  "tl.approvedPolicy": "策略自动批准",
  "tl.approved": "已批准",
  "tl.deniedPolicy": "策略拒绝",
  "tl.rejected": "已拒绝",
  "tl.drafted": "已存草稿",
  "tl.claimed": "已认领",
  "tl.completed": "已完成",
  "tl.failed": "失败",
  "tl.unknown": "结果未知",
  "tl.expired": "已过期",
  "tl.revoked": "已撤销",
  "tl.rule": "规则 {rule}",
  "tl.approval": "审批人 {approver} · 渠道 {channel} · 确认级别 {assurance}",
  "tl.simulated": " · 模拟",
  "tl.reasonRecorded": " · 已记录理由",
  "tl.reason": "理由 {reason}",
  "tl.error": "错误 {code}",
  "hint.channel": "策略不允许网页审批，请用 `actledger approve`",
  "hint.assurance":
    "批准已禁用：这个操作需要 {min} 级别的确认，本页只能记录 app_asserted。请用 CLI（actledger approve {id} --assurance {min}）或已验证的渠道批准。你仍然可以在这里写明理由后拒绝。",
  "hint.stepUp": "批准已禁用：这个操作需要 step-up {stepUp}，本页无法收集。请用 CLI（actledger approve {id} --step-up）。",
  "hint.approver": "审批人不匹配",
  "link.intro": "这个页面只记录一次对该任务的决定，用过之后链接失效。",
  "linkStatus.title": "任务",
  "linkStatus.missing": "这个任务不存在。",
  "linkStatus.state": "当前状态",
  "result.title": "已记录决定",
  "result.task": "任务",
  "result.state": "状态",
  "result.receipt": "回执",
  "result.close": "可以关闭这个页面了。",
  "loginEnded.docTitle": "已退出",
  "loginEnded.title": "已退出登录",
  "loginEnded.body": "你在本审批台的会话已结束。要重新登录，运行 actledger serve --print-login 并打开它打印的链接。",
  "error.docTitle": "出错了",
  "error.title": "出错了",
  "error.code": "错误码",
  "error.back": "返回审批台",
  "error.explain.reason_required": "拒绝必须写理由。请返回并填写理由。",
  "error.explain.origin_rejected": "请求不是从本审批台页面发出的，已拒绝。",
  "error.explain.fetch_site_rejected": "浏览器把它标记为跨站请求，已拒绝。",
  "error.explain.csrf_failed": "表单已过期，请刷新页面后重试。",
  "error.explain.not_found": "这个任务不存在。",
  "error.explain.invalid_request": "请求不合法。",
  "error.explain.invalid_transition": "任务当前的状态已不允许这个决定。",
  "error.explain.task_expired": "这个任务的审批时限已过。",
  "error.explain.presented_hash_mismatch": "页面显示之后任务内容变了，请刷新后重新查看。",
  "error.explain.channel_not_allowed": "策略不允许在这里决定这个任务。",
  "error.explain.approver_mismatch": "你不是这个任务的审批人。",
  "error.explain.assurance_insufficient": "这个任务需要的确认级别高于本页能记录的级别。",
  "error.explain.step_up_required": "这个任务需要额外验证，本页做不到。",
  "error.explain.bad_signature": "审批链接无效。",
  "error.explain.link_expired": "审批链接已过期。",
  "error.explain.link_used": "审批链接已经用过了。",
  "error.explain.nonce_failed": "表单已过期，请重新打开链接。",
};

export { EN, ZH_CN };

const Q_VALUE = /^q=(0(\.\d{0,3})?|1(\.0{0,3})?)$/i;

export function parseAcceptLanguage(header: string | undefined): Locale | null {
  if (!header) return null;
  const slice = header.length > 512 ? header.slice(0, 512) : header;
  const items = slice.split(",").slice(0, 20);
  const ranked: Array<{ tag: string; q: number; index: number }> = [];
  for (let index = 0; index < items.length; index++) {
    const raw = items[index]?.trim() ?? "";
    if (!raw) continue;
    const parts = raw.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
    const tag = (parts[0] ?? "").toLowerCase();
    if (!tag || tag.startsWith("q=")) continue;
    let q = 1;
    let bad = false;
    for (let i = 1; i < parts.length; i++) {
      const param = parts[i] ?? "";
      if (!/^q=/i.test(param)) continue;
      if (!Q_VALUE.test(param)) {
        bad = true;
        break;
      }
      q = Number(param.slice(2));
    }
    if (bad || q === 0) continue;
    ranked.push({ tag, q, index });
  }
  ranked.sort((a, b) => (a.q === b.q ? a.index - b.index : b.q - a.q));
  for (const item of ranked) {
    const primary = item.tag.split("-")[0] ?? "";
    // zh-TW / zh-HK / zh-Hant map to zh-CN: only one Chinese dictionary is shipped, and Simplified is closer than English.
    if (primary === "zh") return "zh-CN";
    if (primary === "en" || item.tag === "*") return "en";
  }
  return null;
}

export function langCookie(locale: Locale): string {
  return `${LANG_COOKIE}=${locale}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function pickLocale(
  headers: http.IncomingHttpHeaders,
  url: URL | null,
): { locale: Locale; setCookie?: string } {
  const requested = url?.searchParams.get("lang");
  if (requested !== null && requested !== undefined) {
    const value = requested.toLowerCase();
    if (value === "en") return { locale: "en", setCookie: langCookie("en") };
    if (value === "zh-cn" || value === "zh") return { locale: "zh-CN", setCookie: langCookie("zh-CN") };
  }
  const cookie = parseCookies(headerString(headers.cookie)).get(LANG_COOKIE);
  if (cookie === "en" || cookie === "zh-CN") return { locale: cookie };
  const accepted = parseAcceptLanguage(headerString(headers["accept-language"]));
  if (accepted) return { locale: accepted };
  return { locale: "en" };
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(EN, key);
}

export function t(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = (locale === "zh-CN" ? ZH_CN : EN)[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars && name in vars ? String(vars[name]) : match,
  );
}
