[English](../en/sdk-python.md) | [简体中文](sdk-python.md)

# Python SDK

`actledger` 包负责校验回执，并驱动本地账本。它不重写引擎。`Ledger(mode="local", dir=...)` 启动 TypeScript CLI 的 `actledger rpc`，一行一个 JSON。

Python 3.10 或更新。运行时依赖 `cryptography`。

## 安装

```bash
pip install actledger
npm i -g @actledger/cli
```

本地模式需要 `PATH` 上有 `actledger`。从克隆做可编辑安装：

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
```

`dev` 包含测试和 LangGraph extra。不要 LangGraph 时用 `"./python[test]"`。

## 校验

```bash
python/.venv/bin/python -m actledger verify receipts.jsonl --keys .actledger/keys.json
python/.venv/bin/python -m actledger verify receipts.jsonl \
  --keys .actledger/keys.json --secrets secrets.jsonl --json
```

成功时打印 `OK ...`，退出码 0。失败时打印 `FAIL seq=... step=...`，退出码 1。`--json` 保持 camelCase，例如 `byMode`、`byAssurance`、`byVersion`。

## 本地客户端

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

公共方法是 snake_case。穿过 rpc 的值在 `actledger._wire` 里仍是 camelCase。

在另一个进程里批准或拒绝：`pnpm actledger approve tsk_... --dir .actledger`，或 `pnpm actledger reject tsk_... --note <reason> --dir .actledger`。

rpc 命令按这个顺序选择：显式的 `command=[...]`，然后是 `ACTLEDGER_RPC_COMMAND`，然后在开发期查找 `packages/cli/src/main.ts` 和 `node_modules/tsx/dist/cli.mjs`，最后是 `PATH` 上的 `actledger`。

## 远端客户端

```python
ledger = Ledger(mode="remote")  # ACTLEDGER_URL 和 ACTLEDGER_API_KEY
```

必须写 `mode="remote"`。`url` 和 `api_key` 缺省时用 `ACTLEDGER_URL` 和 `ACTLEDGER_API_KEY`。`call_timeout`（默认 30 秒）是单次请求超时。`poll_interval` 对本地账本默认 0.2 秒，对远端账本默认 1.0 秒。`allow_insecure_http` 允许回环以外的 `http://`。非默认的 `dir`、`coverage_overlay` 或 `command` 会被拒绝。`sweep()` 不请求服务器。异步代码用 `gate.async_before`、`gate.async_after`、`gate.async_resume`，或 `await asyncio.to_thread(ledger.request, ...)`。没有 `AsyncLedger`。见[远端服务器](scenarios/remote-server.md)和 [HTTP API](../../spec/zh-CN/http.md)。

## 和 TypeScript 的差异

| TypeScript | Python |
| --- | --- |
| `wait({ timeoutMs, pollMs })` | `wait(timeout=900.0, poll_interval=None)`，单位是秒。`None` 用账本默认值：本地 0.2，远端 1.0 |
| `complete` 返回回执对象 | `complete` 返回 dict，用 `receipt["id"]` |
| `Ledger({ mode: "remote", url, apiKey })` | `Ledger(mode="remote", url=..., api_key=...)` |
| `LedgerOptions.now` | 函数传不过 rpc，所以不提供 |

第二次 claim 抛出 `LedgerError`，`code == "already_claimed"`。

## 工具闸门

`actledger.gate.ToolGate` 是与框架无关的挂点：工具执行前调 `before`，返回后调 `after`。`async_before`、`async_after`、`async_resume` 用 `asyncio.to_thread` 把同步方法放到工作线程。见[工具闸门](tool-gate.md)。

## LangGraph

`actledger.langgraph.ledger_gate` 包住一个节点。遇到 `pending_approval` 时，interrupt 里带 `actledger_task_id`、`action`、`payload_hash` 和一条批准提示。interrupt 上不放载荷预览。恢复之后，适配器再从账本读一次任务，然后执行。见 `python/examples/langgraph_email.py`。

协议见 [spec/zh-CN/rpc.md](../../spec/zh-CN/rpc.md)。校验算法见 [spec/zh-CN/verify.md](../../spec/zh-CN/verify.md)。
