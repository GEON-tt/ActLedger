[English](../en/sdk-python.md) | [简体中文](sdk-python.md)

# Python SDK

`actledger` 包负责校验回执，并驱动本地账本。它不重写引擎。`Ledger(mode="local", dir=...)` 启动 TypeScript CLI 的 `actledger rpc`，一行一个 JSON。在克隆里使用客户端之前，先 `pnpm install`。

Python 3.10 或更新。运行时依赖 `cryptography`。还没有上传到 PyPI。

## 安装

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

在另一个进程里批准：`pnpm actledger approve tsk_... --dir .actledger`。

rpc 命令按这个顺序选择：显式的 `command=[...]`，然后是 `ACTLEDGER_RPC_COMMAND`，然后在开发期查找 `packages/cli/src/main.ts` 和 `node_modules/tsx/dist/cli.mjs`，最后是 `PATH` 上的 `actledger`。

## 和 TypeScript 的差异

| TypeScript | Python |
| --- | --- |
| `wait({ timeoutMs, pollMs })` | `wait(timeout=900.0, poll_interval=0.2)`，单位是秒 |
| `complete` 返回回执对象 | `complete` 返回 dict，用 `receipt["id"]` |
| 还没有 HTTP 客户端 | 没有 `api_key` 或 `base_url`。只有本地模式 |
| `LedgerOptions.now` | 函数传不过 rpc，所以不提供 |

第二次 claim 抛出 `LedgerError`，`code == "already_claimed"`。

## 工具闸门

`actledger.gate.ToolGate` 是与框架无关的挂点：工具执行前调 `before`，返回后调 `after`。`async_before`、`async_after`、`async_resume` 用 `asyncio.to_thread` 把同步方法放到工作线程。见[工具闸门](tool-gate.md)。

## LangGraph

`actledger.langgraph.ledger_gate` 包住一个节点。遇到 `pending_approval` 时，interrupt 里带 `actledger_task_id`、`action`、`payload_hash` 和批准命令。interrupt 上不放载荷预览。恢复之后，适配器再从账本读一次任务，然后执行。见 `python/examples/langgraph_email.py`。

协议见 [spec/zh-CN/rpc.md](../../spec/zh-CN/rpc.md)。校验算法见 [spec/zh-CN/verify.md](../../spec/zh-CN/verify.md)。
