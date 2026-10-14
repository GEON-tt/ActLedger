[English](README.md) | [简体中文](README.zh-CN.md)

# OpenAI Agents SDK

文档加上可选的真实模型运行。没有 `OPENAI_API_KEY` 时，脚本打印一行 skip 并以 0 退出。

不需要 key 的证明：

```bash
pnpm exec vitest run packages/openai-agents/test/adapter.test.ts
```

Python，先 `pip install -e "./python[test,openai-agents]"`：

```bash
python/.venv/bin/python -m pytest python/tests/test_openai_agents.py -q
```

在仓库根目录运行。脚本打印批准提示后，在另一个终端用 `actledger approve` 或 `actledger serve` 批准。等待超过 5 分钟会打印 `still pending, giving up` 并以 0 退出。任务留在 `pending_approval`。

```bash
OPENAI_API_KEY=… pnpm exec tsx examples/openai-agents/run.ts
```

`state.approve` 是 SDK 让 run 继续的调用，不是账本审批。账本审批在另一个终端完成。

没包住的工具和 `mcpServers` 里的工具不会进账本。这是 recorded。要强制 MCP 工具，走 MCP 代理。见 [OpenAI Agents SDK](../../docs/zh-CN/integrations.md#openai-agents-sdk)。

Python 写法是同一页里的 Python 代码段。这个示例不另带 `.py`。
