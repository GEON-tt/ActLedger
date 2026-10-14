[English](approval.md) | [简体中文](../zh-CN/approval.md)

# Approval

ActLedger approvals happen outside the agent. This page covers the local CLI, the loopback approval page, and signed webhooks.

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

`actledger approve` and `actledger reject` record channel `cli`. See [Getting started](getting-started.md). The approver is the task's principal. An assurance above `app_asserted`, or `--step-up`, is marked `simulated`.

## 3. Local page

```bash
actledger serve --dir .actledger --port 4319 --approver <principal>
```

The process binds `127.0.0.1` only. There is no flag to change that. It prints the origin and a one-time login URL. Opening that URL sets a session cookie and burns the token. The same URL then returns 401. Restart `serve` to mint a new one. Restarting also drops every session.

The cookie is `actledger_session`. It is `HttpOnly`, `SameSite=Strict`, and `Path=/`. It has no `Secure` attribute and no `Max-Age`: this server speaks plain HTTP on loopback, and browsers do not reliably store `Secure` cookies for `http://127.0.0.1`. The cookie is a session cookie. The server expires it after 12 idle hours, or 24 hours from creation, whichever comes first.

Session posts send a per-session CSRF token and must come from an allowed `Origin` (`http://127.0.0.1:<port>`, `http://localhost:<port>`, or the origin of `public_url`). A `Sec-Fetch-Site` header, when present, must be `same-origin` or `none`. Every request must carry an allowed `Host`, or the server answers 421. GET never approves or rejects.

Without `--approver`, the page approves as `task.principalId`, the same identity the CLI uses. That default is not the application name `local`. With `--approver`, the value is passed through. Only tasks whose principal matches can be approved; the others return `403 approver_mismatch`.

The page cannot edit the payload, cannot collect step-up, and can only assert `app_asserted`. If the task needs a higher assurance or a step-up, the approve button is disabled. Rejection is still available unless the channel itself is not allowed.

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

The confirmation page uses a one-time form nonce plus the same Origin check as the session page. It does not set a session cookie. The decision is channel `webhook_link`, assurance `app_asserted`, and the approver is always the task principal. `--approver` is not applied.

## 7. What app_asserted means

Web and link approvals record that this application claims the user confirmed. They are not a channel identity check. `simulated` is `false` because the receipt does not claim a higher assurance. For a higher level in local testing, use the CLI's simulated assurance. A real `channel_verified` or `user_signed` channel is not part of this release.
