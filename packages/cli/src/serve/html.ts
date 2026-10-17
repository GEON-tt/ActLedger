export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE =
  "body{font:16px/1.45 ui-sans-serif,system-ui,sans-serif;margin:2rem auto;max-width:52rem;color:#1c1917;background:#fafaf9}" +
  "a{color:#1d4ed8}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e7e5e4;text-align:left;padding:.4rem .5rem;vertical-align:top}" +
  "pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e7e5e4;padding:.75rem}" +
  "button{font:inherit;padding:.35rem .8rem}.warn{background:#fff7ed;border:1px solid #fdba74;padding:.6rem .75rem}" +
  "nav a{margin-right:1rem}fieldset{border:1px solid #e7e5e4;margin:1rem 0;padding:.75rem}ol{padding-left:1.2rem}";

export interface ListRow {
  id: string;
  type: string;
  level: string;
  state: string;
  principalId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  intent: string;
  args: string;
}

export interface TimelineRow {
  at: string;
  seq: number;
  label: string;
  actor: string;
  detail: string;
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

const TAB_TITLE = {
  pending: "Pending approvals",
  recent: "Recent decisions",
  all: "All tasks",
} as const;

const TAB_LABEL = {
  pending: "Pending",
  recent: "Recent",
  all: "All",
} as const;

function page(title: string, body: string, bodyAttrs?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body${bodyAttrs ? ` ${bodyAttrs}` : ""}>
${body}
</body>
</html>
`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function pre(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`;
}

function actionType(actionJson: string): string {
  try {
    const parsed = JSON.parse(actionJson) as { type?: unknown };
    if (typeof parsed.type === "string") return parsed.type;
  } catch {
    // Display JSON is produced by the server. A parse failure falls back to empty.
  }
  return "";
}

export function renderList(input: { tab: "pending" | "recent" | "all"; rows: ListRow[]; csrf: string }): string {
  const title = TAB_TITLE[input.tab];
  const body = `<h1>${escapeHtml(title)}</h1>
<nav>
${(["pending", "recent", "all"] as const)
  .map((tab) => {
    const current = tab === input.tab ? ` aria-current="page"` : "";
    return `<a href="/?tab=${tab}"${current}>${escapeHtml(TAB_LABEL[tab])}</a>`;
  })
  .join("\n")}
</nav>
<table>
<thead><tr><th>Task</th><th>Action</th><th>Level</th><th>State</th><th>Principal</th><th>Created</th><th>Expires</th><th>Args</th><th>Intent</th></tr></thead>
<tbody id="task-rows">
${
  input.rows.length === 0
    ? `<tr><td colspan="9">No tasks.</td></tr>`
    : input.rows
        .map(
          (row) => `<tr>
<td><a href="/tasks/${encodeURIComponent(row.id)}">${escapeHtml(row.id)}</a></td>
<td>${escapeHtml(row.type)}</td>
<td>${escapeHtml(row.level)}</td>
<td>${escapeHtml(row.state)}</td>
<td>${escapeHtml(row.principalId)}</td>
<td>${escapeHtml(row.createdAt)}</td>
<td>${escapeHtml(row.expiresAt)}</td>
<td>${escapeHtml(row.args)}</td>
<td>${escapeHtml(row.intent)}</td>
</tr>`,
        )
        .join("\n")
}
</tbody>
</table>
<p id="updated-at"></p>
<footer>
<form method="post" action="/logout">
${hidden("csrf", input.csrf)}
<button type="submit">Log out</button>
</form>
</footer>
<script src="/assets/console.js"></script>`;
  return page(title, body, `data-tab="${escapeHtml(input.tab)}"`);
}

export function renderDetail(task: TaskPage): string {
  const hints = task.hints.map((hint) => `<p class="warn">${escapeHtml(hint)}</p>`).join("\n");
  const decision = task.decisionInfo
    ? `<h2>Decision</h2>
<dl>
<dt>decision</dt><dd>${escapeHtml(task.decisionInfo.decision)}</dd>
<dt>approver</dt><dd>${escapeHtml(task.decisionInfo.approver)}</dd>
<dt>channel</dt><dd>${escapeHtml(task.decisionInfo.channel)}</dd>
<dt>assurance</dt><dd>${escapeHtml(task.decisionInfo.assurance)}</dd>
<dt>simulated</dt><dd>${task.decisionInfo.simulated ? "yes" : "no"}</dd>
<dt>decided at</dt><dd>${escapeHtml(task.decisionInfo.decidedAt)}</dd>
<dt>reason</dt><dd>${task.decisionInfo.noteRecorded ? "recorded" : "none"}</dd>
</dl>`
    : "";
  const timeline =
    task.timeline.length === 0
      ? "<li>(timeline unavailable)</li>"
      : task.timeline
          .map(
            (row) =>
              `<li><time>${escapeHtml(row.at)}</time> <strong>${escapeHtml(row.label)}</strong> ${escapeHtml(row.actor)} ${escapeHtml(row.detail)}</li>`,
          )
          .join("\n");
  const editNote = task.allowEdit
    ? `<p>Editing before approval is only available in the CLI (actledger approve ${escapeHtml(task.id)} --edit file.json). This page approves the payload exactly as shown.</p>`
    : "";
  const forms = task.pending
    ? `<form method="post" action="/tasks/${encodeURIComponent(task.id)}/approve">
<fieldset>
<legend>You are approving</legend>
<p>action <code>${escapeHtml(actionType(task.action))}</code></p>
<h3>args</h3>${pre(task.args)}
<p>presented_hash <code>${escapeHtml(task.payloadHash)}</code></p>
${editNote}
</fieldset>
${hidden("csrf", task.csrf)}
${hidden("presented_hash", task.payloadHash)}
<button type="submit"${task.approveDisabled ? " disabled" : ""}>Approve</button>
</form>
<form method="post" action="/tasks/${encodeURIComponent(task.id)}/reject">
${hidden("csrf", task.csrf)}
${hidden("presented_hash", task.payloadHash)}
<label>Reason (required) <textarea name="reason" required maxlength="2000"></textarea></label>
<button type="submit"${task.rejectDisabled ? " disabled" : ""}>Reject</button>
</form>`
    : "";
  const payloadTitle =
    !task.pending && task.approvedPayloadEdited ? "Approved payload (edited before approval)" : "Payload";
  const approvedHash =
    !task.pending && task.approvedPayloadEdited
      ? `<p>approved_payload_hash <code>${escapeHtml(task.approvedPayloadHash)}</code></p>`
      : "";
  return page(
    task.id,
    `<p><a href="/">Pending</a></p>
<h1>${escapeHtml(task.id)}</h1>
${hints}
<dl>
<dt>state</dt><dd>${escapeHtml(task.state)}</dd>
<dt>principalId</dt><dd>${escapeHtml(task.principalId)}</dd>
<dt>agentId</dt><dd>${escapeHtml(task.agentId)}</dd>
<dt>createdAt</dt><dd>${escapeHtml(task.createdAt)}</dd>
<dt>expiresAt</dt><dd>${escapeHtml(task.expiresAt)}</dd>
<dt>ruleId</dt><dd>${escapeHtml(task.ruleId)}</dd>
<dt>result</dt><dd>${escapeHtml(task.result)}</dd>
<dt>minAssurance</dt><dd>${escapeHtml(task.minAssurance)}</dd>
<dt>stepUp</dt><dd>${escapeHtml(task.stepUp)}</dd>
<dt>channels</dt><dd>${escapeHtml(task.channels)}</dd>
<dt>payload_hash</dt><dd>${escapeHtml(task.payloadHash)}</dd>
</dl>
${decision}
<h2>Timeline</h2>
<ol class="timeline">
${timeline}
</ol>
<h2>Action</h2>
${pre(task.action)}
<h2>Intent</h2>
${pre(task.intent)}
<h2>${escapeHtml(payloadTitle)}</h2>
${pre(task.payload)}
${approvedHash}
${forms}
<footer>
<form method="post" action="/logout">
${hidden("csrf", task.csrf)}
<button type="submit">Log out</button>
</form>
</footer>`,
  );
}

export function renderLink(task: LinkPage): string {
  return page(
    task.id,
    `<h1>${escapeHtml(task.id)}</h1>
<dl>
<dt>state</dt><dd>${escapeHtml(task.state)}</dd>
<dt>ruleId</dt><dd>${escapeHtml(task.ruleId)}</dd>
<dt>result</dt><dd>${escapeHtml(task.result)}</dd>
<dt>minAssurance</dt><dd>${escapeHtml(task.minAssurance)}</dd>
<dt>stepUp</dt><dd>${escapeHtml(task.stepUp)}</dd>
<dt>channels</dt><dd>${escapeHtml(task.channels)}</dd>
<dt>payload_hash</dt><dd>${escapeHtml(task.payloadHash)}</dd>
</dl>
<h2>Action</h2>
${pre(task.action)}
<h2>Intent</h2>
${pre(task.intent)}
<h2>Payload</h2>
${pre(task.payload)}
<form method="post" action="/t/${encodeURIComponent(task.id)}">
${hidden("sig", task.sig)}
${hidden("exp", task.exp)}
${hidden("nonce", task.nonce)}
${hidden("presented_hash", task.payloadHash)}
${hidden("decision", "approve")}
<p><button type="submit">Approve</button></p>
</form>
<form method="post" action="/t/${encodeURIComponent(task.id)}">
${hidden("sig", task.sig)}
${hidden("exp", task.exp)}
${hidden("nonce", task.nonce)}
${hidden("presented_hash", task.payloadHash)}
${hidden("decision", "reject")}
<p><label>Reason (required) <textarea name="reason" required maxlength="2000"></textarea></label></p>
<p><button type="submit">Reject</button></p>
</form>`,
  );
}

export function renderLinkStatus(id: string, state: string | null): string {
  if (!state) {
    return page("Task", "<h1>Task</h1><p>This task does not exist.</p>");
  }
  return page(
    "Task",
    `<h1>Task</h1><p>task ${escapeHtml(id)}</p><p>state ${escapeHtml(state)}</p>`,
  );
}

export function renderResult(id: string, state: string, receiptHash: string): string {
  return page(
    "Recorded",
    `<h1>Decision recorded</h1>
<p>task ${escapeHtml(id)}</p>
<p>state ${escapeHtml(state)}</p>
<p>receipt ${escapeHtml(receiptHash)}</p>`,
  );
}

export function renderError(code: string, message: string): string {
  return page("Error", `<h1>Error</h1><p>${escapeHtml(code)}</p><p>${escapeHtml(message)}</p>`);
}
