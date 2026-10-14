[English](https://github.com/GEON-tt/ActLedger/blob/main/python/README.md) | [简体中文](#简体中文)

# ActLedger Python SDK

Receipt verifier, local ledger client, and an optional LangGraph adapter. The runtime dependency is `cryptography`. There is no console script with the same name as the npm packages. The entry point is `python -m actledger`.

## Install

From a clone of this repository:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e "./python[test]"
```

With the LangGraph adapter:

```bash
.venv/bin/python -m pip install -e "./python[test,langgraph]"
```

With the Claude Agent SDK adapter:

```bash
.venv/bin/python -m pip install -e "./python[test,claude]"
```

With the OpenAI Agents SDK adapter:

```bash
.venv/bin/python -m pip install -e "./python[test,openai-agents]"
```

Python `>=3.10`. Use the stdlib `venv` and `pip`. This package is not uploaded to PyPI yet.

## Verify

```bash
python -m actledger verify receipts.jsonl --keys keys.json [--secrets secrets.jsonl] [--json]
```

On success, stdout is `OK ...`. On failure, stderr is `FAIL seq=...`. Exit codes match the TypeScript CLI. `--json` keeps the engine's camelCase field names (`byMode`, `byAssurance`, `byVersion`) so the report can be compared with TypeScript.

## Local client

`Ledger(mode="local", dir=...)` does not implement the ledger in Python. It starts the TypeScript CLI command `actledger rpc` and calls the same engine with one JSON object per line on stdio. Approve and reject still run in another process as `actledger approve` / `actledger reject`.

The command is chosen in this order:

1. `Ledger(..., command=["..."])`
2. `ACTLEDGER_RPC_COMMAND`, split with shell rules, for example `npx -y @actledger/cli rpc`
3. During development: walk up from the installed package to a repository root that contains both `packages/cli/src/main.ts` and `node_modules/tsx/dist/cli.mjs`, then run the CLI source with `node` and `tsx`. The working directory is the repository root, and `--dir` is an absolute path.
4. After publication: `actledger rpc` on `PATH` (from `npm i -g @actledger/cli`)

The child process sets `NODE_OPTIONS=--disable-warning=ExperimentalWarning`. Diagnostics on stderr are not treated as failure.

## Differences from the TypeScript SDK

| Design note or TypeScript | Python |
| --- | --- |
| `Ledger(api_key=..., base_url=...)` | Only `Ledger(mode="local", dir=...)` |
| `wait({ timeoutMs, pollMs })` | `wait(timeout=900.0, poll_interval=0.2)`, in seconds |
| No separate exception when someone else claimed the task | `LedgerError` with `code == "already_claimed"` |
| `complete` returns a receipt object | Returns a receipt dict; use `receipt["id"]` |
| Error codes may be any string in some drafts | `error.code` must match `^[a-z0-9_.]{1,64}$` |
| Guard payload is required; the return value is not reported | Same |
| Network retries and a cached chain head | Not implemented |
| `ledger_gate` infers the action from the call in some drafts | Same parameters as `guard`: `action`, `principal`, `payload` |
| Interrupt value includes `task.preview` | Only `actledger_task_id`, `action`, `payload_hash`, and the approve command |
| `LedgerOptions.now` | Not provided; a function cannot cross rpc |

Public methods use snake_case. rpc params and results stay in the engine's camelCase. The mapping lives in `actledger._wire`.

## Tests

From the repository root, run `pnpm install` first (parity checks and rpc need tsx):

```bash
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -e "./python[test,langgraph,claude,openai-agents]"
python/.venv/bin/python -m pytest python/tests
```

Vector checks that do not need Node:

```bash
python/.venv/bin/python -m pytest python/tests/test_vectors.py
```

If `langgraph` is not installed, tests marked `langgraph` are skipped and the core package still imports. CI sets `ACTLEDGER_REQUIRE_NODE=1`. The job that installs langgraph also sets `ACTLEDGER_REQUIRE_LANGGRAPH=1`. Tests marked `claude` are skipped unless `claude-agent-sdk` is installed. The job that installs the Claude extra sets `ACTLEDGER_REQUIRE_CLAUDE=1`. Tests marked `openai_agents` are skipped unless the `openai-agents` distribution is installed. The job that installs that extra sets `ACTLEDGER_REQUIRE_OPENAI=1`. Smoke tests that call a real model also need `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and are skipped when the matching key is absent.

Longer guide: <https://github.com/GEON-tt/ActLedger/blob/main/docs/en/sdk-python.md>.

## 简体中文

回执校验器、本地账本客户端，以及可选的 LangGraph、Claude Agent SDK 和 OpenAI Agents SDK 适配器。入口是 `python -m actledger`，不是和 npm 包同名的 console script。Claude 适配器需要 `pip install -e "./python[claude]"`。OpenAI Agents 适配器需要 `pip install -e "./python[openai-agents]"`。没装对应 extra 时，标了 `claude` 或 `openai_agents` 的测试会跳过；CI 里安装了这些 extra 的任务会设置 `ACTLEDGER_REQUIRE_CLAUDE=1` 和 `ACTLEDGER_REQUIRE_OPENAI=1`。真实模型冒烟测试还需要 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`，没有密钥就跳过。

在仓库根：

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
python/.venv/bin/python -m actledger verify receipts.jsonl --keys keys.json
```

`Ledger(mode="local")` 通过 `actledger rpc` 调用 TypeScript 引擎。批准和拒绝仍用 `actledger approve` / `actledger reject`。用法说明：<https://github.com/GEON-tt/ActLedger/blob/main/docs/zh-CN/sdk-python.md>。仓库说明：<https://github.com/GEON-tt/ActLedger/blob/main/README.zh-CN.md>。
