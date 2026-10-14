[English](rpc.md) | [简体中文](zh-CN/rpc.md)

# Local rpc

`actledger rpc` runs a one-JSON-object-per-line protocol on stdio for the Python SDK `Ledger(mode="local")`. It opens a local `LedgerEngine`. It is not the HTTP API, and it does not stand in for a future HTTP service. Approve and reject are not part of this protocol. They remain `actledger approve` / `actledger reject`.

## Frames

Each message is one line of UTF-8 JSON ending in `\n`. The server handles messages synchronously in arrival order. Response order matches request order.

```json
{"id": 7, "method": "claim", "params": {"id": "tsk_...", "idempotencyKey": "..."}}
{"id": 7, "ok": true, "result": {}}
{"id": 7, "ok": false, "error": {"code": "already_claimed", "message": "...", "status": 409, "details": {}}}
```

The client generates `id` and the server echoes it. If the request is not valid JSON, or it has no string `method`, the response is `id: null` and `code: invalid_request`, and the connection stays open. An unknown method is `method_not_found`, status 404. A `LedgerError` from the engine is returned with its `code`, `message`, `status`, and `details`. Any other exception is `internal` / 500, and the process does not exit.

## Methods

Params and results use the engine's camelCase.

| method | params | result |
| --- | --- | --- |
| `hello` | `{}` | `{ protocol: "actledger.rpc/1", appId, dir, version }` |
| `request` | `principalId`, `action`, `payload`, and optional `agentId`, `intent`, `expiresIn`, `idempotencyKey`, `metadata` | `{ task, receipts }` |
| `get_task` | `{ id }` | `{ task }`. `task` is null when missing |
| `claim` | `{ id, idempotencyKey?, agentId? }` | `{ task, approvedPayload, approvedPayloadHash, executionDeadline, receipt }` |
| `complete` | `{ id, executedPayload, externalProofs?, result?, idempotencyKey? }` | `{ task, contentMatch, receipt }` |
| `fail` | `{ id, error, partial?, idempotencyKey? }` | `{ task, receipt }` |
| `revoke` | `{ id, reason?, idempotencyKey? }` | `{ task, receipt }`. The actor is that task's agent |
| `sweep` | `{}` | `{ expired, unknown }` |
| `set_coverage_overlay` | `{ entries }` | `{ receipt }` |
| `shutdown` | `{}` | `{}` |

Methods that need `id` require a non-empty string. Otherwise the error is `invalid_request`. The remaining fields are validated by the engine.

## Lifecycle

Startup calls `openLedger({ dir })`. If the directory was not initialized, stdout gets one error line with `id: null` and the process exits 1.

`shutdown` writes the response, then closes the engine, and exits 0. Closing stdin or receiving `SIGTERM` closes the engine and exits 0. Diagnostics go only to stderr.
