[English](sdk-python.md) | [简体中文](../zh-CN/sdk-python.md)

# Python SDK

The `actledger` package verifies receipts and drives a local ledger. It does not reimplement the engine. `Ledger(mode="local", dir=...)` starts `actledger rpc` from the TypeScript CLI and speaks one JSON object per line. Install Node dependencies with `pnpm install` before using the client from a clone.

Python 3.10 or newer. Runtime dependency: `cryptography`. Not uploaded to PyPI yet.

## Install

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

Approve in another process: `pnpm actledger approve tsk_... --dir .actledger`.

The rpc command is chosen in this order: an explicit `command=[...]`, then `ACTLEDGER_RPC_COMMAND`, then a development lookup for `packages/cli/src/main.ts` and `node_modules/tsx/dist/cli.mjs`, then `actledger` on `PATH`.

## Differences from TypeScript

| TypeScript | Python |
| --- | --- |
| `wait({ timeoutMs, pollMs })` | `wait(timeout=900.0, poll_interval=0.2)` in seconds |
| `complete` returns a receipt object | `complete` returns a dict; use `receipt["id"]` |
| No HTTP client | No `api_key` or `base_url`. Local mode only |
| `LedgerOptions.now` | Not available across rpc |

A second claim raises `LedgerError` with `code == "already_claimed"`.

## LangGraph

`actledger.langgraph.ledger_gate` wraps a node. On `pending_approval` it interrupts with `actledger_task_id`, `action`, `payload_hash`, and the approve command. It does not put a preview of the payload on the interrupt. After resume, the adapter reads the task from the ledger again, then executes. See `python/examples/langgraph_email.py`.

The protocol is [spec/rpc.md](../../spec/rpc.md). The verifier algorithm is [spec/verify.md](../../spec/verify.md).
