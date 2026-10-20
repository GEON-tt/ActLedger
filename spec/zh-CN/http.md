[English](../http.md) | [简体中文](http.md)

# HTTP API

规范性用词与[规范说明](README.md)相同。

## 1. 范围

本文件是单租户 `@actledger/server` 的 HTTP 接口。兼容的服务器或客户端实现这些路由、状态码和错误 code。后面的审批台是资料性的，不是兼容 agent 客户端的要求。

## 2. 传输

使用 HTTPS。回环地址可以用 HTTP。正文是 UTF-8 JSON。正文超过 1 MiB 时返回 `413`，`code` 为 `payload_too_large`。`/v1` 下的每个 POST 必须带 `Content-Type: application/json`，否则 `415` `unsupported_media_type`。空正文当作 `{}`。

## 3. 认证

agent 调用和 audit 调用发送 `Authorization: Bearer <key>`。agent key 可以为自己的 agent 和自己的 principal 创建并推进任务。audit key 可以读 `GET /v1/export`，不能调用任务路由（`403` `forbidden`，消息 `audit keys are read-only`）。`GET /healthz` 和 `GET /v1/keys` 不需要 key。

缺少或无法识别的 bearer key 是 `401` `unauthorized`，带 `WWW-Authenticate: Bearer realm="actledger"`，正文是 `{ "code": "unauthorized", "message": "missing or invalid api key", "status": 401, "details": {} }`。

## 4. 错误

JSON 错误是 `{ "code", "message", "status", "details" }`。`details` 是对象。`421` 是纯文本 `misdirected request`，不是 JSON。未预期的服务器失败是 `500` `{ "code": "internal", "message": "internal error", "status": 500, "details": {} }`。

| code | status | 何时 |
| --- | --- | --- |
| `unauthorized` | 401 | bearer key 缺失或无效，或需要审批人会话时会话不存在 |
| `forbidden` | 403 | audit key 打到任务路由、agent key 导出，或 agent key 调用 approve、reject、reconcile |
| `not_found` | 404 | 未知路由、非法任务 id，或任务不存在、不属于这把 key |
| `method_not_allowed` | 405 | 已知路由上的方法不对 |
| `unsupported_media_type` | 415 | POST 没有 `Content-Type: application/json` |
| `payload_too_large` | 413 | 正文超过 1 MiB |
| `invalid_request` | 400 | 字段类型或形状不对 |
| `agent_mismatch` | 403 | 传了 `agentId`，且不等于 key 的 agent |
| `principal_not_allowed` | 403 | `principalId` 不在 key 的 principal 列表里 |
| `invalid_transition` | 409 | 引擎拒绝这次状态迁移 |
| `already_claimed` | 409 | `claim` 做了两次 |
| `idempotency_conflict` | 409 | 同一个键配了不同的 body |
| `content_mismatch` | 422 | `executedPayload` 和批准载荷不一致 |
| `ledger_unavailable` | 503 | 引擎打不开账本 |
| `internal` | 500 | 未预期的失败 |

## 5. 端点

路径里的任务 id 做百分号编码。不是任务 id 的路径段返回 `404` `not_found`。

### GET /healthz

不认证。响应 `200` `{ "ok": true }`。其他方法是 `405`。

### GET /v1/keys

不认证。响应 `200` 是公钥集合，形状与 `keys.json` 相同。其他方法是 `405`。

### GET /v1/export

查询参数 `from` 和 `to` 是可选的整数，且 `>= 1`。其他值是 `400` `invalid_request`。响应 `200` `application/x-ndjson`，一行一条回执。

请求带了 `Authorization` 时，bearer key 必须是 audit key。agent key 是 `403` `forbidden`。没有 `Authorization` 时，Host 必须是服务器允许的，并且 `actledger_session` cookie 必须是有效的审批人会话。Host 不对是 `421` 纯文本。没有会话是 `401` `unauthorized`，不带 `WWW-Authenticate`。导出的是整条链，不按 principal 过滤。

除 GET 以外的方法是 `405`。

### POST /v1/tasks

需要 agent key。正文字段：

| 字段 | 规则 |
| --- | --- |
| `principalId` | 必填。非空字符串。必须在 key 的 principal 列表里 |
| `action` | 必填对象 |
| `payload` | 必填对象 |
| `agentId` | 可选字符串。如果出现，必须等于 key 的 agent。记下来的 agent 始终是 key 的 agent |
| `intent` | 可选字符串或 null |
| `expiresIn` | 可选数字 |
| `metadata` | 可选对象 |
| `idempotencyKey` | 可选。1–128 个可见 ASCII（`0x21`–`0x7e`） |

响应 `200` `{ "task", "receipts" }`，与 `engine.request` 的返回值相同。

### GET /v1/tasks/{id}

需要 agent key。响应 `200` `{ "task" }`。任务不存在，或 `agentId` 不是这把 key 的 agent，或 `principalId` 不在 key 的列表里，都是 `404` `not_found`。除 GET 以外的方法是 `405`。

### POST /v1/tasks/{id}/claim

需要 agent key，并且任务属于这把 key，否则 `404`。正文是 JSON。`idempotencyKey` 可选。正文里的 `agentId` 被忽略；服务器用 key 的 agent 去 claim。响应 `200` 是 claim 结果：`task`、`approvedPayload`、`approvedPayloadHash`、`executionDeadline`、`receipt`。

### POST /v1/tasks/{id}/complete

需要 agent key，并且任务属于这把 key，否则 `404`。`executedPayload` 是必填对象。`externalProofs` 是可选数组。`result` 是可选对象。`idempotencyKey` 可选。响应 `200` 是 complete 结果：`task`、`contentMatch`、`receipt`。

### POST /v1/tasks/{id}/fail

需要 agent key，并且任务属于这把 key，否则 `404`。`error` 是必填对象，含字符串 `code` 和 `message`，以及可选布尔值 `retryable`。`partial` 是可选布尔值。`idempotencyKey` 可选。响应 `200` `{ "task", "receipt" }`。

### POST /v1/tasks/{id}/revoke

需要 agent key，并且任务属于这把 key，否则 `404`。`reason` 是可选字符串。`idempotencyKey` 可选。回执上的 actor 是 `{ "type": "agent", "id": <key 的 agent> }`。响应 `200` `{ "task", "receipt" }`。

### POST /v1/tasks/{id}/approve、reject、reconcile

agent key 得到 `403` `forbidden`，消息是 `agent keys cannot approve, reject, or reconcile tasks`。正文不会被执行。audit key 打到这些路径得到 `403` `forbidden`，消息是 `audit keys are read-only`。

## 6. 幂等

重放规则与[本地 rpc](rpc.md) 使用的引擎规则相同。键是 1–128 个可见 ASCII。`POST /v1/tasks` 的键在整个 app 范围内。claim、complete、fail、revoke 的键在该任务范围内。同一个键配同一个 body 返回原来的结果。同一个键配不同的 body 是 `409` `idempotency_conflict`。客户端可以重试一个带了键的请求。

## 7. 归属

读任务和写任务都要求 `task.agentId == key.agentId`，且 `task.principalId` 在 `key.principalIds` 里。对不上是 `404` `not_found`，不是 `403`，因此一把 key 分不出「别人的任务」和「没有这个任务」。创建任务在写入前检查 principal 和可选的 `agentId`，这两种不匹配用 `403`。

## 8. 审批台

资料性。这些路由是附带的审批台的行为。兼容的 agent 客户端不调用它们。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /login` | 登录表单。已有会话则重定向到 `GET /` |
| `POST /login` | 表单字段 `username`、`password`、`totp`。需要 `Origin`（或审批台的同站回退）。成功是 `303 /`，并 `Set-Cookie: actledger_session=...` |
| `POST /logout` | 结束会话 |
| `GET /` | 当前会话 principal 的任务列表。查询参数 `tab` 为 `pending`、`recent` 或 `all` |
| `GET /api/tasks` | 该 principal 的 JSON 列表。查询参数 `state` 为 `pending`、`recent` 或 `all` |
| `GET /tasks/{id}` | 详情页。隐藏字段 `csrf` 和 `presented_hash` |
| `POST /tasks/{id}/approve` | 表单字段 `csrf`、`presented_hash`。需要 `Origin` 和会话 CSRF。成功是 `303 /tasks/{id}` |
| `POST /tasks/{id}/reject` | 相同，另外 `reason` 必填 |

会话 cookie 是 `HttpOnly`、`SameSite=Strict`、`Path=/`，请求是 HTTPS 时再加 `Secure`。空闲 30 分钟，绝对 12 小时。批准或拒绝记为 `channel: web`、`assurance: app_asserted`、`stepUp: false`。

## 9. 反向代理

没有 `--trust-proxy` 时，服务器用 socket 地址，并把请求当作 HTTP。有 `--trust-proxy` 时，客户端 IP 是 `X-Forwarded-For` 的最后一项（没有该头时用 socket 地址），Host 在有 `X-Forwarded-Host` 时取其第一项，`X-Forwarded-Proto: https` 表示 HTTPS。Caddy 默认转发的头与此一致。
