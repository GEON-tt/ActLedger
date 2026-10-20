[English](sdk-python.md) | [简体中文](../zh-CN/sdk-python.md)

# Python SDK

The `actledger` package verifies receipts and drives a local ledger. It does not reimplement the engine. `Ledger(mode="local", dir=...)` starts `actledger rpc` from the TypeScript CLI and speaks one JSON object per line.

Python 3.10 or newer. Runtime dependency: `cryptography`.

## Install

```bash
pip install actledger
npm i -g @actledger/cli
```

Local mode needs `actledger` on `PATH`. From a clone, an editable install is:

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
```

`dev` includes tests and the LangGraph extra. Without LangGraph, use `"./python[test]"`.

## Verify

```bash
python/.venv/bin/python -m actledger verify receipts.jsonl --keys .actledger/keys.json
python/.venv/bin/python -m actledger verify receipts.jsonl \
  --keys .actledger/keys.json --secrets secrets.jsonl --json
```

Success prints `OK ...` and exits 0. Failure prints `FAIL seq=... step=...` and exits 1. `--json` keeps camelCase names such as `byMode`, `byAssurance`, and `byVersion`.

## Local client

```python
from actledger import Ledger

ledger = Ledger(dir=".actledger")
task = ledger.request(
    principal_id="u_1",
    action={"type": "calendar.create"},
    payload={"action": "calendar.create", "args": {"title": "standup"}},
    intent="create a standup",
)
ready = task.wait(timeout=60)
if ready.state == "approved":
    run = ready.claim()
    receipt = run.complete(executed_payload=run.approved_payload)
ledger.close()
```

Public methods are snake_case. Values that cross rpc stay camelCase inside `actledger._wire`.

Approve or reject in another process: `pnpm actledger approve tsk_... --dir .actledger`, or `pnpm actledger reject tsk_... --note <reason> --dir .actledger`.

The rpc command is chosen in this order: an explicit `command=[...]`, then `ACTLEDGER_RPC_COMMAND`, then a development lookup for `packages/cli/src/main.ts` and `node_modules/tsx/dist/cli.mjs`, then `actledger` on `PATH`.

## Remote client

```python
ledger = Ledger(mode="remote")  # ACTLEDGER_URL and ACTLEDGER_API_KEY
```

`mode="remote"` is required. `url` and `api_key` fall back to `ACTLEDGER_URL` and `ACTLEDGER_API_KEY`. `call_timeout` (default 30 seconds) is the per-request timeout. `poll_interval` defaults to 0.2 seconds for a local ledger and 1.0 second for a remote ledger. `allow_insecure_http` allows `http://` beyond loopback. A non-default `dir`, a `coverage_overlay`, or a `command` is rejected. `sweep()` does not call the server. In async code use `gate.async_before`, `gate.async_after`, and `gate.async_resume`, or `await asyncio.to_thread(ledger.request, ...)`. There is no `AsyncLedger`. See [A remote server](scenarios/remote-server.md) and the [HTTP API](../../spec/http.md).

## Differences from TypeScript

| TypeScript | Python |
| --- | --- |
| `wait({ timeoutMs, pollMs })` | `wait(timeout=900.0, poll_interval=None)` in seconds. `None` uses the ledger default: 0.2 local, 1.0 remote |
| `complete` returns a receipt object | `complete` returns a dict; use `receipt["id"]` |
| `Ledger({ mode: "remote", url, apiKey })` | `Ledger(mode="remote", url=..., api_key=...)` |
| `LedgerOptions.now` | Not available across rpc |

A second claim raises `LedgerError` with `code == "already_claimed"`.

## Tool gate

`actledger.gate.ToolGate` is the framework-neutral hook: `before` before the tool runs, `after` when it returns. `async_before`, `async_after`, and `async_resume` run the sync methods on a worker thread via `asyncio.to_thread`. See [tool gate](tool-gate.md).

## LangGraph

`actledger.langgraph.ledger_gate` wraps a node. On `pending_approval` it interrupts with `actledger_task_id`, `action`, `payload_hash`, and an approve hint. It does not put a preview of the payload on the interrupt. After resume, the adapter reads the task from the ledger again, then executes. See `python/examples/langgraph_email.py`.

The protocol is [spec/rpc.md](../../spec/rpc.md). The verifier algorithm is [spec/verify.md](../../spec/verify.md).
