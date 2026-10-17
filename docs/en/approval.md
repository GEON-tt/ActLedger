[English](approval.md) | [简体中文](../zh-CN/approval.md)

# Approval

ActLedger approvals happen outside the agent. This page covers the local CLI, the loopback approval page, and signed webhooks. For a walkthrough, see [the approval console scenario](scenarios/approval-console.md).

## 1. Channels

A task stores the merged `approval.channels` list from the policy that was current when the task was created. `approve` and `reject` both name a channel:

| Channel | Where it comes from |
| --- | --- |
| `cli` | `actledger approve` / `actledger reject` |
| `web` | The page from `actledger serve` |
| `webhook_link` | A signed link carried in a webhook |

The engine accepts the decision only when that channel is in the task's list. An empty list, or a policy that omits `channels`, means `[cli]`. Anything else returns `403 channel_not_allowed` and writes no receipt. The list is fixed on the task. Editing `policy.yaml` later changes only tasks created after the edit.

`actledger init` writes a default policy whose channels are `[cli, web]`. `webhook_link` stays off until you add it. A directory created before this default still has `[cli]`. Add `web` (and `webhook_link` if you want links) under `defaults.approval.channels`, then create a new task. Tasks that are already pending keep the old list; the detail page says when the web channel is not allowed.

## 2. CLI

`actledger approve` and `actledger reject` record channel `cli`. See [Getting started](getting-started.md). The approver is the task's principal. An assurance above `app_asserted`, or `--step-up`, is marked `simulated`. `actledger reject` requires `--note <reason>` (`--reason` is an alias).

## 3. Local page

```bash
actledger serve --dir .actledger --port 4319 --approver <principal>
```

The process binds `127.0.0.1` only. There is no flag to change that. It prints the origin and a login URL. The token lives in `.actledger/serve.token` (mode 0600, or `--token-file <path>`), survives restarts, and can be used to log in again; each login opens a new session. `actledger serve --print-login` prints the same URL and exits without starting the server. `actledger serve --rotate-token` writes a new token, so older login URLs and every existing session stop working, then starts the server and prints the new URL. `--one-time-login` keeps the old behavior: an in-memory token that works once and is never written to disk.

The token file is created with mode 0600; a looser mode is tightened and logged. An unreadable or malformed file stops serve with `invalid token file; run actledger serve --rotate-token`. `--token-file` needs an existing parent directory. `--print-login` needs an initialized directory, prints only the URL on stdout, and builds it from `--port` (default 4319), not from `public_url`. A rotation from another process takes effect in a running serve on its next request. `--one-time-login` cannot be combined with `--token-file`, `--rotate-token`, or `--print-login`, and `--print-login` cannot be combined with `--approver`.

The cookie is `actledger_session`. It is `HttpOnly`, `SameSite=Strict`, and `Path=/`. It has no `Secure` attribute and no `Max-Age`: this server speaks plain HTTP on loopback, and browsers do not reliably store `Secure` cookies for `http://127.0.0.1`. The cookie is a session cookie. The server expires it after 12 idle hours, or 24 hours from creation, whichever comes first. A token rotation also ends every session. Log out ends only the current session; the login URL keeps working.

Session posts send a per-session CSRF token. If the request has an `Origin`, it must be an allowed origin (`http://127.0.0.1:<port>`, `http://localhost:<port>`, or the origin of `public_url`). If `Origin` is missing or `null` (some Safari versions), the post is accepted only when `Sec-Fetch-Site` is `same-origin` or `none`, or `Referer` comes from an allowed origin; the CSRF token and the `SameSite=Strict` session cookie are still required. A `Sec-Fetch-Site` header, when present, must be `same-origin` or `none`. Every request must carry an allowed `Host`, or the server answers 421. GET never approves or rejects, and opening the login URL needs no `Origin`.

The page loads one same-origin script, `/assets/console.js`. The Content-Security-Policy is `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, and `Referrer-Policy` is `same-origin`.

Without `--approver`, the page approves as `task.principalId`, the same identity the CLI uses. That default is not the application name `local`. With `--approver`, the value is passed through. Only tasks whose principal matches can be approved or rejected; for the others both buttons are disabled and the engine returns `403 approver_mismatch`.

The page cannot edit the payload, cannot collect step-up, and can only assert `app_asserted`. If the task needs a higher assurance or a step-up, the approve button is disabled. The page explains why and prints the CLI command (`actledger approve <id> --assurance <min>` or `--step-up`). A higher assurance comes from the rule's `approval.min_assurance`, or from an action level of `send`, `spend`, or `delete` when the rule sets none (raised to `channel_verified`). Rejection is still available unless the channel itself is not allowed. A rejection needs a reason: the page answers `400 reason_required` without one, and `actledger reject` requires `--note`. A reason longer than 2000 characters is `400 invalid_request`.

The list has three tabs: `pending` (waiting for approval, oldest first), `recent` (human decisions, newest first, up to 50), and `all` (newest first, up to 200). The page refreshes the current tab every 3 seconds from `GET /api/tasks?state=pending|recent|all`, which needs the session cookie and returns `{tab, now, tasks}`; each task has `id`, `state`, `action` (`type`, `level`, `resource`), `principalId`, `createdAt`, `updatedAt`, `expiresAt`, `expired`, `decided`, `intent`, and `args` (both clipped to 120 characters). `content` and the full payload are not included. When the session ends, the page says so and points to `actledger serve --print-login`.

The task page shows a "You are approving" block with the action, the args, and the `presented_hash` the decision is bound to. When the rule allows editing, the page says editing is only available with `actledger approve <id> --edit file.json`. After a human decision it shows the approver, channel, assurance, whether it was simulated, and whether a reason was recorded. The timeline is built from the task's receipts: requested, pending approval, approved by policy, approved, denied by policy, rejected, drafted, claimed, completed, failed, unknown, expired, revoked.

## 4. channels.yaml

`actledger init` writes `.actledger/channels.yaml` as a commented example and creates `keys/link-hmac.key`. `actledger serve` reads the file. A missing file, or a file that is only comments, means zero channels. A syntax or schema error refuses to start. A missing or empty environment variable skips that channel, logs it, and leaves the others running.

```yaml
public_url: http://127.0.0.1:4319
channels:
  - name: team-webhook
    type: webhook
    url: https://example.com/actledger-hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    events: [task.pending_approval, task.approved, task.rejected]
    include_payload: false
```

| Field | Meaning |
| --- | --- |
| `public_url` | Optional. `http` or `https`, no query or hash. Links and detail URLs use it. When omitted, serve uses `http://127.0.0.1:<actual port>`. A non-loopback host is only a warning. The listener stays on 127.0.0.1. |
| `name` | Lowercase identifier, unique |
| `type` | `webhook` only |
| `url` | `http` or `https` endpoint |
| `secret_env` | Name of an environment variable. Never put the secret itself in the file |
| `events` | Optional. Default `[task.pending_approval]`. Allowed values: `task.pending_approval`, `task.approved`, `task.rejected` |
| `include_payload` | Optional boolean, default `false` |

`task.pending_approval` fires when a task enters that state, including tasks that are already pending the first time serve sees them. `task.approved` and `task.rejected` fire only for a human decision (`approvalId` is set). Policy allow and policy deny do not send those events. A jump from unseen to approved sends only `task.approved`.

## 5. Webhook signature

Each delivery is a JSON object with the `WebhookEvent` shape `{id, type, created_at, data}`. Retry keeps the same `id` and body and signs again with a new timestamp.

```
ActLedger-Signature: t=<unix seconds>,v1=<hex hmac>
ActLedger-Event: task.pending_approval
ActLedger-Delivery: evt_...
```

The HMAC-SHA256 key is the channel secret. It covers the UTF-8 string `t + "." + raw body`. Receivers should allow a 300 second window. `ActLedger-Delivery` is the event id; use it to drop duplicates. Other headers: `Content-Type: application/json` and `User-Agent: actledger-serve/0.1.0`.

```ts
import { verifyWebhook } from "@actledger/sdk/webhook";

const event = verifyWebhook(
  rawBody,
  request.headers["actledger-signature"],
  process.env.ACTLEDGER_WEBHOOK_SECRET ?? "",
);
```

A runnable receiver that prints approve_url is in [examples/webhook-receiver](../../examples/webhook-receiver).

`data` carries `task_id`, `state`, `action` (`type`, `level`, `resource`), `payload_hash`, `intent_commit`, `task_created_at`, `approve_url`, and `detail_url`. `approve_url` is a signed link only for `task.pending_approval` when the task allows `webhook_link`; otherwise it is `null`. `detail_url` always requires a session. Human decisions add `decided_by: "user"`. `include_payload: true` adds `data.payload` and `data.intent`, or `null` if they cannot be decrypted.

Delivery is at most four attempts (the first try plus three retries). The waits are `retryBaseMs * 2^(n-1)` (1s, 2s, 4s by default). Each attempt times out after 10 seconds. 2xx succeeds. Network errors, timeouts, 5xx, and 429 retry. Other 4xx fail immediately. 3xx is a failure and is not followed.

`.actledger/notify.log` is JSON Lines, mode 0600. A line looks like:

```json
{"ts":"...","event_id":"evt_...","event":"task.pending_approval","task_id":"tsk_...","channel":"team-webhook","attempt":1,"outcome":"retry","status":503,"url_host":"example.com"}
```

`outcome` is `delivered`, `retry`, `failed`, or `skipped`. Failures may include `error` (a message, not the body). Skips include `reason: "missing_secret_env"` and `secret_env` (the variable name). The log never stores the body, payload, intent, secret, or `approve_url`. The target is `url_host` only. Delivery is not written into the ledger.

## 6. Signed links

Add `webhook_link` to the task's `approval.channels` or the webhook's `approve_url` is `null`. A link lasts 15 minutes (`keys/link-hmac.key`, 32 raw bytes, mode 0600, separate from the receipt key and the data key). It is bound to the task id and payload hash, and it works once. Serve marks it used before calling the engine, so a failed approve still consumes it. Used signatures are stored as SHA-256 in `.actledger/link-used.jsonl` (mode 0600), not as the raw signature. Delete `keys/link-hmac.key` and restart serve to invalidate outstanding links.

The link points at `public_url`. Serve still listens only on 127.0.0.1. Reaching that URL from another machine is your own forwarding, which this release does not set up. The link is a bearer credential. Do not post it to a public channel.

The confirmation page uses a one-time form nonce plus the same Origin rule as the session page (a missing Origin needs `Sec-Fetch-Site: same-origin`/`none` or an allowed `Referer`). It does not set a session cookie. A link rejection needs a reason, and a missing reason does not use up the link. The decision is channel `webhook_link`, assurance `app_asserted`, and the approver is always the task principal. `--approver` is not applied.

## 7. What app_asserted means

Web and link approvals record that this application claims the user confirmed. They are not a channel identity check. `simulated` is `false` because the receipt does not claim a higher assurance. For a higher level in local testing, use the CLI's simulated assurance. A real `channel_verified` or `user_signed` channel is not part of this release.
