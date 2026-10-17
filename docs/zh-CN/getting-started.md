[English](../en/getting-started.md) | [简体中文](getting-started.md)

# 入门

ActLedger 记录你主动接入的 agent 动作。策略决定一次调用是放行、等待批准、拒绝，还是只保留草稿。每次状态迁移都追加一条签名回执，`actledger verify` 可以离线校验。

0.1.0 还没有发布。下面的命令从克隆的源码运行。

## 环境

- Node.js 22.13 或更新
- pnpm 9（根目录 `package.json` 的 `packageManager`）
- 可选：Python 3.10 或更新，用于 Python 包

## 从源码运行

```bash
git clone https://github.com/GEON-tt/ActLedger.git
cd ActLedger
corepack enable
pnpm install
pnpm actledger init
```

`init` 在 `.actledger/` 生成 Ed25519 密钥、数据密钥、`ledger.db` 和 `policy.yaml`。这个目录里有密钥，不要提交。

列出任务、批准、导出、校验：

```bash
pnpm actledger tasks
pnpm actledger approve tsk_...
pnpm -s actledger export > receipts.jsonl
pnpm actledger verify receipts.jsonl --keys .actledger/keys.json
pnpm actledger show rcp_...
```

CLI 批准默认是 `app_asserted`。`--assurance channel_verified` 或 `user_signed` 只用于本地测试，回执会标成 `simulated`，因为 CLI 并不做真实的渠道身份确认。

把代理放在 MCP 服务器前面：

```bash
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

接着看 [mcp-proxy.md](mcp-proxy.md)、[sdk-typescript.md](sdk-typescript.md)、[sdk-python.md](sdk-python.md)。

## 示例

`pnpm demo` 启动聊天页和审批台。默认模型是内置的 fake 模型，不需要 API key。见 [examples/chat-approval](../../examples/chat-approval)。

邮件示例会一直等到批准：

```bash
pnpm actledger init --policy examples/local-email-agent/policy.yaml
# 另一个终端
pnpm exec tsx examples/local-email-agent/run.ts
pnpm actledger approve tsk_... --assurance channel_verified
```

运行 MCP 代理的邮件示例：

```bash
pnpm exec tsx examples/mcp-proxy-email/run.ts
```

`actledger serve` 的 webhook 接收端不需要 API key。步骤见 [examples/webhook-receiver](../../examples/webhook-receiver)：

```bash
ACTLEDGER_WEBHOOK_SECRET=dev-secret pnpm exec tsx examples/webhook-receiver/run.ts
```

适配器示例：`examples/claude-agent` 需要 `ANTHROPIC_API_KEY`，`examples/openai-agents` 需要 `OPENAI_API_KEY`。没有 key 时打印跳过说明并以 0 退出。不需要 key 的测试是 `packages/claude-agent-sdk/test/adapter.test.ts` 和 `packages/openai-agents/test/adapter.test.ts`。

`examples/*/run-agent.ts` 会调用 Cursor SDK。运行前把仓库根目录的 `.env.example` 复制为 `.env` 并填写 `CURSOR_API_KEY`。不要提交 `.env`。

按场景写的分步页面：[场景](scenarios/own-loop.md)。

## 回执用来做什么

回执写明谁发起、哪条规则生效、谁以什么保证等级批准、批准的载荷是什么、实际执行的载荷是什么。哈希链证明这份记录事后没有被改。它不证明 agent 的每个动作都记下来了。见 [guarantees.md](guarantees.md)。

## 发布后

包发到 npm 之后：

```bash
npx -y @actledger/cli init
npx -y @actledger/mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

```bash
npx @actledger/cli tasks --dir .actledger
npx @actledger/cli approve tsk_... --dir .actledger
npx @actledger/cli export --dir .actledger > receipts.jsonl
npx @actledger/cli verify receipts.jsonl --keys .actledger/keys.json
```

Python 在发到 PyPI 之后可以用 `pip install actledger`。本仓库目前不上传。

字段规则见[规范](../../spec/zh-CN/README.md)。各部分怎么拼在一起见 [architecture.md](architecture.md)。
