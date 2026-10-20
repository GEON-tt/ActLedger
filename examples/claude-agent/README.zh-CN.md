[English](README.md) | [简体中文](README.zh-CN.md)

# Claude Agent SDK

文档加上可选的真实模型运行。没有 `ANTHROPIC_API_KEY` 时，脚本打印一行 skip 并以 0 退出。

不需要 key 的证明：

```bash
pnpm exec vitest run packages/claude-agent-sdk/test/adapter.test.ts
```

Python，先 `pip install -e "./python[test,claude]"`：

```bash
python/.venv/bin/python -m pytest python/tests/test_claude_agent.py -q
```

在仓库根目录运行。另一个终端按脚本打印的命令批准，或者在审批台（`pnpm actledger serve --dir <账本目录>`）批准。`policy.yaml` 把 `send_note` 声明为 `level: write`，两种方式在默认的 `app_asserted` 保证下都能批。

```bash
ANTHROPIC_API_KEY=… pnpm exec tsx examples/claude-agent/run.ts
```

`send_note` 会让 `canUseTool` 阻塞，直到批准或 5 分钟闸门超时。超时后适配器拒绝该工具，任务仍是 `pending_approval`。

这个适配器跑在 agent 进程里，是 recorded。不要把这两个工具放进 `allowedTools`，否则 Claude 会跳过 `canUseTool`。见 [Claude Agent SDK](../../docs/zh-CN/integrations.md#claude-agent-sdk)。

Python 写法是同一页里的 Python 代码段。这个示例不另带 `.py`。
