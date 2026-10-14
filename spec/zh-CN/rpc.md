[English](../rpc.md) | [简体中文](rpc.md)

# 本地 rpc

`actledger rpc` 在 stdio 上跑一行一个 JSON 的协议，给 Python SDK 的 `Ledger(mode="local")` 用。它打开的是本地 `LedgerEngine`，不是 HTTP API，也不能代替以后的 HTTP 服务。批准和拒绝不在这个协议里，仍然用 `actledger approve` / `actledger reject`。

## 帧

每条消息是一行 UTF-8 JSON，以 `\n` 结尾。服务端按收到的顺序同步处理，响应顺序和请求顺序一致。

```json
{"id": 7, "method": "claim", "params": {"id": "tsk_...", "idempotencyKey": "..."}}
{"id": 7, "ok": true, "result": {}}
{"id": 7, "ok": false, "error": {"code": "already_claimed", "message": "...", "status": 409, "details": {}}}
```

`id` 由客户端生成，原样回传。请求不是合法 JSON，或者没有字符串 `method` 时，返回 `id: null`、`code: invalid_request`，连接保持。未知方法是 `method_not_found`，status 404。引擎的 `LedgerError` 原样带上 `code`、`message`、`status`、`details`。其他异常是 `internal` / 500，进程不退出。

## 方法

params 和 result 用引擎的 camelCase。

| method | params | result |
| --- | --- | --- |
| `hello` | `{}` | `{ protocol: "actledger.rpc/1", appId, dir, version }` |
| `request` | `principalId`、`action`、`payload`，以及可选的 `agentId`、`intent`、`expiresIn`、`idempotencyKey`、`metadata` | `{ task, receipts }` |
| `get_task` | `{ id }` | `{ task }`，没有则 `task` 为 null |
| `claim` | `{ id, idempotencyKey?, agentId? }` | `{ task, approvedPayload, approvedPayloadHash, executionDeadline, receipt }` |
| `complete` | `{ id, executedPayload, externalProofs?, result?, idempotencyKey? }` | `{ task, contentMatch, receipt }` |
| `fail` | `{ id, error, partial?, idempotencyKey? }` | `{ task, receipt }` |
| `revoke` | `{ id, reason?, idempotencyKey? }` | `{ task, receipt }`，actor 是该任务的 agent |
| `sweep` | `{}` | `{ expired, unknown }` |
| `set_coverage_overlay` | `{ entries }` | `{ receipt }` |
| `shutdown` | `{}` | `{}` |

需要 `id` 的方法，`id` 必须是非空字符串，否则 `invalid_request`。其余字段交给引擎校验。

## 生命周期

启动时 `openLedger({ dir })`。目录没初始化时，stdout 写一行 `id: null` 的错误，退出码 1。

`shutdown` 先写完响应，再关掉引擎，退出码 0。stdin 关闭或收到 `SIGTERM` 时关掉引擎，退出码 0。诊断信息只写 stderr。
