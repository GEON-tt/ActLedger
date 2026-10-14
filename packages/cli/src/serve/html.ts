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
  "button{font:inherit;padding:.35rem .8rem}.warn{background:#fff7ed;border:1px solid #fdba74;padding:.6rem .75rem}";

export interface ListRow {
  id: string;
  type: string;
  level: string;
  principalId: string;
  createdAt: string;
  expiresAt: string;
  intent: string;
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

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
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

export function renderList(rows: ListRow[], csrf: string): string {
  const table =
    rows.length === 0
      ? "<p>No tasks are waiting for approval.</p>"
      : `<table>
<thead><tr><th>Task</th><th>Action</th><th>Level</th><th>Principal</th><th>Created</th><th>Expires</th><th>Intent</th></tr></thead>
<tbody>
${rows
  .map(
    (row) => `<tr>
<td><a href="/tasks/${encodeURIComponent(row.id)}">${escapeHtml(row.id)}</a></td>
<td>${escapeHtml(row.type)}</td>
<td>${escapeHtml(row.level)}</td>
<td>${escapeHtml(row.principalId)}</td>
<td>${escapeHtml(row.createdAt)}</td>
<td>${escapeHtml(row.expiresAt)}</td>
<td>${escapeHtml(row.intent)}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table>`;
  return page(
    "Pending approvals",
    `<h1>Pending approvals</h1>
${table}
<footer>
<form method="post" action="/logout">
${hidden("csrf", csrf)}
<button type="submit">Log out</button>
</form>
</footer>`,
  );
}

export function renderDetail(task: TaskPage): string {
  const hints = task.hints.map((hint) => `<p class="warn">${escapeHtml(hint)}</p>`).join("\n");
  const forms = task.pending
    ? `<form method="post" action="/tasks/${encodeURIComponent(task.id)}/approve">
${hidden("csrf", task.csrf)}
${hidden("presented_hash", task.payloadHash)}
<button type="submit"${task.approveDisabled ? " disabled" : ""}>Approve</button>
</form>
<form method="post" action="/tasks/${encodeURIComponent(task.id)}/reject">
${hidden("csrf", task.csrf)}
${hidden("presented_hash", task.payloadHash)}
<label>Reason <textarea name="reason"></textarea></label>
<button type="submit"${task.rejectDisabled ? " disabled" : ""}>Reject</button>
</form>`
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
<h2>Action</h2>
${pre(task.action)}
<h2>Intent</h2>
${pre(task.intent)}
<h2>Payload</h2>
${pre(task.payload)}
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
<p><button type="submit" name="decision" value="approve">Approve</button></p>
<p><label>Reason <textarea name="reason"></textarea></label></p>
<p><button type="submit" name="decision" value="reject">Reject</button></p>
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
