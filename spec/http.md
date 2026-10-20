[English](http.md) | [简体中文](zh-CN/http.md)

# HTTP API

The normative words are the same as in the [specification README](README.md).

## 1. Scope

This file is the HTTP interface of the single-tenant `@actledger/server`. A compatible server or client implements these routes, status codes, and error codes. The approval console later in this file is informative. It is not a requirement for a compatible agent client.

## 2. Transport

Use HTTPS. HTTP is acceptable on a loopback host. Bodies are JSON, UTF-8. A request body larger than 1 MiB is `413` with `code` `payload_too_large`. Every POST under `/v1` MUST send `Content-Type: application/json`; anything else is `415` `unsupported_media_type`. An empty body is `{}`.

## 3. Authentication

Agent and audit calls send `Authorization: Bearer <key>`. An agent key can create and drive tasks for its agent and its principals. An audit key can read `GET /v1/export` and cannot call task routes (`403` `forbidden`, message `audit keys are read-only`). `GET /healthz` and `GET /v1/keys` do not require a key.

A missing or unknown bearer key is `401` `unauthorized` with `WWW-Authenticate: Bearer realm="actledger"` and body `{ "code": "unauthorized", "message": "missing or invalid api key", "status": 401, "details": {} }`.

## 4. Errors

JSON errors use `{ "code", "message", "status", "details" }`. `details` is an object. `421` is plain text `misdirected request`, not JSON. An unexpected server failure is `500` `{ "code": "internal", "message": "internal error", "status": 500, "details": {} }`.

| code | status | When |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or invalid bearer key, or a console session is missing where one is required |
| `forbidden` | 403 | Audit key on a task route, agent key on export, or agent key on approve, reject, or reconcile |
| `not_found` | 404 | Unknown route, bad task id, or a task that does not exist or is not owned by this key |
| `method_not_allowed` | 405 | Wrong method for a known route |
| `unsupported_media_type` | 415 | POST without `Content-Type: application/json` |
| `payload_too_large` | 413 | Body over 1 MiB |
| `invalid_request` | 400 | A field has the wrong type or shape |
| `agent_mismatch` | 403 | `agentId` was sent and is not the key's agent |
| `principal_not_allowed` | 403 | `principalId` is not in the key's principal list |
| `invalid_transition` | 409 | The engine rejected the state change |
| `already_claimed` | 409 | `claim` ran twice |
| `idempotency_conflict` | 409 | The same key was reused with a different body |
| `content_mismatch` | 422 | `executedPayload` does not match the approved payload |
| `ledger_unavailable` | 503 | The engine could not open the ledger |
| `internal` | 500 | Unexpected failure |

## 5. Endpoints

Task ids in the path are percent-encoded. A path segment that is not a task id is `404` `not_found`.

### GET /healthz

No authentication. Response `200` `{ "ok": true }`. Any other method is `405`.

### GET /v1/keys

No authentication. Response `200` is the public key set, the same shape as `keys.json`. Any other method is `405`.

### GET /v1/export

Query `from` and `to` are optional integers `>= 1`. Anything else is `400` `invalid_request`. Response `200` `application/x-ndjson`, one receipt per line.

If the request has an `Authorization` header, the bearer key MUST be an audit key. An agent key is `403` `forbidden`. If it has no `Authorization` header, the host must be one the server allows, and the `actledger_session` cookie must be a live approver session. A bad host is `421` plain text. A missing session is `401` `unauthorized` without `WWW-Authenticate`. The export is the whole chain. It is not filtered by principal.

Any method other than GET is `405`.

### POST /v1/tasks

Requires an agent key. Body fields:

| field | rule |
| --- | --- |
| `principalId` | Required. Non-empty string. Must be in the key's principal list |
| `action` | Required object |
| `payload` | Required object |
| `agentId` | Optional string. If present, it MUST equal the key's agent. The stored agent is always the key's agent |
| `intent` | Optional string or null |
| `expiresIn` | Optional number |
| `metadata` | Optional object |
| `idempotencyKey` | Optional. 1–128 visible ASCII characters (`0x21`–`0x7e`) |

Response `200` `{ "task", "receipts" }`, the same object `engine.request` returns.

### GET /v1/tasks/{id}

Requires an agent key. Response `200` `{ "task" }`. A task that does not exist, or whose `agentId` is not the key's agent, or whose `principalId` is not in the key's list, is `404` `not_found`. Any method other than GET is `405`.

### POST /v1/tasks/{id}/claim

Requires an agent key and ownership, or `404`. Body is JSON. `idempotencyKey` is optional. An `agentId` in the body is ignored; the server claims as the key's agent. Response `200` is a claim result: `task`, `approvedPayload`, `approvedPayloadHash`, `executionDeadline`, `receipt`.

### POST /v1/tasks/{id}/complete

Requires an agent key and ownership, or `404`. `executedPayload` is a required object. `externalProofs` is an optional array. `result` is an optional object. `idempotencyKey` is optional. Response `200` is a complete result: `task`, `contentMatch`, `receipt`.

### POST /v1/tasks/{id}/fail

Requires an agent key and ownership, or `404`. `error` is a required object with string `code` and `message`, and an optional boolean `retryable`. `partial` is an optional boolean. `idempotencyKey` is optional. Response `200` `{ "task", "receipt" }`.

### POST /v1/tasks/{id}/revoke

Requires an agent key and ownership, or `404`. `reason` is an optional string. `idempotencyKey` is optional. The actor recorded on the receipt is `{ "type": "agent", "id": <key agent> }`. Response `200` `{ "task", "receipt" }`.

### POST /v1/tasks/{id}/approve, reject, reconcile

An agent key receives `403` `forbidden` with message `agent keys cannot approve, reject, or reconcile tasks`. The body is not applied. An audit key on these paths receives `403` `forbidden` with message `audit keys are read-only`.

## 6. Idempotency

Replay rules are the engine rules used by [local rpc](rpc.md). A key is 1–128 visible ASCII characters. The key on `POST /v1/tasks` is scoped to the whole app. The key on claim, complete, fail, and revoke is scoped to that task. The same key and the same body return the original result. The same key and a different body is `409` `idempotency_conflict`. A client can retry a request that included a key.

## 7. Ownership

Task reads and task writes require `task.agentId == key.agentId` and `task.principalId` in `key.principalIds`. A miss is `404` `not_found`, not `403`, so one key cannot tell another agent's task ids apart from missing ones. Creating a task checks the principal and the optional `agentId` before insert and uses `403` for those mismatches.

## 8. Approval console

Informative. These routes are how the bundled console works. A compatible agent client does not call them.

| method and path | behavior |
| --- | --- |
| `GET /login` | Login form. A live session redirects to `GET /` |
| `POST /login` | Form fields `username`, `password`, `totp`. Requires `Origin` (or the console's same-site fallback). Success is `303 /` and `Set-Cookie: actledger_session=...` |
| `POST /logout` | Ends the session |
| `GET /` | Task list for the session's principal. Query `tab` is `pending`, `recent`, or `all` |
| `GET /api/tasks` | JSON list for that principal. Query `state` is `pending`, `recent`, or `all` |
| `GET /tasks/{id}` | Detail page. Hidden fields `csrf` and `presented_hash` |
| `POST /tasks/{id}/approve` | Form fields `csrf`, `presented_hash`. Requires `Origin` and the session CSRF token. Success is `303 /tasks/{id}` |
| `POST /tasks/{id}/reject` | Same, plus required `reason` |

The session cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` when the request is HTTPS. Idle lifetime is 30 minutes. Absolute lifetime is 12 hours. An approval or rejection is recorded as `channel: web`, `assurance: app_asserted`, `stepUp: false`.

## 9. Reverse proxy

Without `--trust-proxy`, the server uses the socket address and treats the request as HTTP. With `--trust-proxy`, the client IP is the last item of `X-Forwarded-For` (or the socket address when that header is absent), the host is the first item of `X-Forwarded-Host` when present, and HTTPS is `X-Forwarded-Proto: https`. Caddy's default forwarded headers match this.
