[English](README.md) | [简体中文](README.zh-CN.md)

# ActLedger

一条命令给任意 MCP 服务器加上审批和可验证回执。

0.1.0 还没有发布。下面的命令从克隆的源码运行。

```bash
git clone https://github.com/GEON-tt/ActLedger.git
cd ActLedger
corepack enable
pnpm install
pnpm actledger init
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

`pnpm actledger init` 在 `.actledger/` 生成 Ed25519 签名密钥、数据密钥、`ledger.db` 和 `policy.yaml`。`pnpm mcp-proxy` 包住上游 MCP 服务器。每次 `tools/call` 先按 `policy.yaml` 决定放行、等批准还是拒绝，再把结果写成签名回执。

没在 `policy.yaml` 的 `actions` 里声明的工具走 `defaults.unknown_action`（默认 `require_approval`）。工具名含 shell、exec、http、fetch、browser 的，代理会警告它们可能绕过代理。

在同一个克隆里批准和校验：

```bash
pnpm actledger tasks --dir .actledger
pnpm actledger approve tsk_... --dir .actledger
pnpm -s actledger export --dir .actledger > receipts.jsonl
pnpm actledger verify receipts.jsonl --keys .actledger/keys.json
```

在 MCP 客户端（Cursor、Claude Desktop 等）里指向这份源码，`--ledger` 用绝对路径：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "pnpm",
      "args": [
        "-s", "--dir", "/absolute/path/to/actledger",
        "mcp-proxy",
        "--ledger", "/absolute/path/to/.actledger",
        "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/project"
      ]
    }
  }
}
```

## 包地图

| 包 | 用途 |
| --- | --- |
| [`@actledger/core`](packages/core) | 回执、载荷承诺、状态机、策略求值、校验、SQLite 账本 |
| [`@actledger/sdk`](packages/sdk) | TypeScript `Ledger`：request、wait、claim、complete |
| [`@actledger/cli`](packages/cli) | `actledger`：初始化、批准、导出、校验 |
| [`@actledger/mcp-proxy`](packages/mcp-proxy) | 放在上游服务器前面的 stdio MCP 代理 |
| [`@actledger/claude-agent-sdk`](packages/claude-agent-sdk) | Claude Agent SDK 适配器：在工具闸门上挂 `canUseTool` 和 `PostToolUse` 钩子 |
| [`@actledger/openai-agents`](packages/openai-agents) | OpenAI Agents SDK 适配器：在工具闸门上做 `needsApproval` 中断和 execute 记录 |
| [`actledger`](python)（Python） | 回执校验器、经 `actledger rpc` 访问本地账本的客户端、可选的 LangGraph、Claude Agent SDK 和 OpenAI Agents SDK 适配器 |

协议字段见 [spec/zh-CN/README.md](spec/zh-CN/README.md)。架构概要见 [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)。

## 保证边界

没接入的动作不在保证范围内。已经接入的动作分两档。详见 [docs/zh-CN/guarantees.md](docs/zh-CN/guarantees.md)。

- **记录式。** 用 SDK 包住工具。账本能审批和校验这些调用，但不能阻止模型用 shell、通用 HTTP 或浏览器绕过去。
- **强制式。** 代理或凭证闸门放在 agent 进程外面。MCP 代理已经实现，属于强制式。凭证闸门还没有做。

哈希链证明的是「记下来的内容没有被改过」，不是「所有动作都记下来了」。

没有专门适配器的框架可以用工具闸门：工具调用前调 `before`，返回后调 `after`。它是 recorded 接入，强制路径仍然是 MCP 代理。详见 [docs/zh-CN/tool-gate.md](docs/zh-CN/tool-gate.md)。

Claude Agent SDK 和 OpenAI Agents SDK 有基于同一个闸门的适配器，同样是 recorded 接入。[docs/zh-CN/integrations.md](docs/zh-CN/integrations.md) 对比了工具闸门、两个适配器和 MCP 代理。

需要本地审批页面和签名 webhook 时运行 `actledger serve`，它只绑定 127.0.0.1。详见 [docs/zh-CN/approval.md](docs/zh-CN/approval.md)。

## TypeScript SDK

在本仓库里，SDK 通过 workspace 解析。发布之后用 `npm install @actledger/sdk`。

```ts
import { Ledger } from "@actledger/sdk";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const task = await ledger.request({
  principalId: "u_1",
  action: { type: "calendar.create" },
  payload: { action: "calendar.create", args: { title: "standup" } },
  intent: "create a standup",
});
const ready = await task.wait({ timeoutMs: 60_000 });
if (ready.state === "approved") {
  const run = await ready.claim();
  await run.complete({ executedPayload: run.approvedPayload });
}
ledger.close();
```

`claim` 把 `approved` 推进到 `executing`，并且只能成功一次。认领之后进程如果挂了，任务会变成 `unknown`，不会被当成「没执行」再试一次。详见 [docs/zh-CN/sdk-typescript.md](docs/zh-CN/sdk-typescript.md)。

## Python

Python 3.10 或更新。用标准库 `venv` 和 `pip`。

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
python/.venv/bin/python -m actledger verify receipts.jsonl --keys .actledger/keys.json
```

`Ledger(mode="local", dir=...)` 不在 Python 里重写引擎。它启动 TypeScript CLI 的 `actledger rpc`，用一行一个 JSON 的协议通信。批准和拒绝仍然在另一个进程里执行 `actledger approve` / `actledger reject`。在克隆里要先 `pnpm install`，客户端才能找到 `tsx`。详见 [docs/zh-CN/sdk-python.md](docs/zh-CN/sdk-python.md)。

## 环境

Node.js 22.13 或更新，以及 pnpm 9。本仓库在 `package.json` 里固定了包管理器。

## 本地开发

`init` 会在 `.actledger/` 里生成密钥和默认策略。CLI 批准默认是 `app_asserted`。`--assurance channel_verified` 或 `user_signed` 只用于本地测试，回执会标成 `simulated`，因为 CLI 并没有做真实的渠道身份确认。

```bash
pnpm actledger tasks
pnpm actledger approve tsk_... --assurance channel_verified
pnpm -s actledger export > receipts.jsonl
pnpm actledger verify receipts.jsonl --keys .actledger/keys.json
pnpm actledger show rcp_...
```

邮件示例会一直等到批准：

```bash
pnpm actledger init --policy examples/local-email-agent/policy.yaml
# 另一个终端
pnpm exec tsx examples/local-email-agent/run.ts
pnpm actledger approve tsk_... --assurance channel_verified
```

MCP 代理的邮件示例：

```bash
pnpm exec tsx examples/mcp-proxy-email/run.ts
```

`actledger serve` 的 webhook 接收端，不需要 API key。步骤见 [examples/webhook-receiver](examples/webhook-receiver)：

```bash
ACTLEDGER_WEBHOOK_SECRET=dev-secret pnpm exec tsx examples/webhook-receiver/run.ts
```

适配器示例：[examples/claude-agent](examples/claude-agent) 需要 `ANTHROPIC_API_KEY`，[examples/openai-agents](examples/openai-agents) 需要 `OPENAI_API_KEY`。没有 key 时打印跳过说明并以 0 退出。不需要 key 的测试是 `packages/claude-agent-sdk/test/adapter.test.ts` 和 `packages/openai-agents/test/adapter.test.ts`。

`examples/*/run-agent.ts` 会调用 Cursor SDK。运行前把 `.env.example` 复制为 `.env` 并填写 `CURSOR_API_KEY`。不要提交 `.env`。

## 规范

协议格式见 [spec/zh-CN/README.md](spec/zh-CN/README.md)。英文版见 [spec/README.md](spec/README.md)。JSON Schema 和 `spec/test-vectors/` 两种语言共用。

## 测试与构建

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
python/.venv/bin/pytest python -q
```

`pnpm test` 直接跑 TypeScript 源码，不需要先构建。`pnpm pack:check` 会打包并联网安装，单独跑。

## 参与贡献

见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)、[SECURITY.zh-CN.md](SECURITY.zh-CN.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

指南：[入门](docs/zh-CN/getting-started.md)、[MCP 代理](docs/zh-CN/mcp-proxy.md)、[TypeScript SDK](docs/zh-CN/sdk-typescript.md)、[Python SDK](docs/zh-CN/sdk-python.md)、[工具闸门](docs/zh-CN/tool-gate.md)、[框架集成](docs/zh-CN/integrations.md)、[审批](docs/zh-CN/approval.md)、[保证边界](docs/zh-CN/guarantees.md)、[架构](docs/zh-CN/architecture.md)。

## 社区插件

还没有收录的社区插件。通过 PR 申请加入这份列表。

## 还没有做

HTTP 服务、PostgreSQL、托管审批页、飞书或邮件渠道、凭证闸门、RFC 3161 锚定，以及 Java SDK。后面接这些时走 `Store` 和 SDK 的 `Transport`。

## 发布后

0.1.0 发到 npm 之后，可以不克隆仓库：

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

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "@actledger/mcp-proxy",
        "--ledger", "/absolute/path/to/.actledger",
        "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/project"
      ]
    }
  }
}
```

Python 在发到 PyPI 之后可以用 `pip install actledger`。本仓库目前不上传。

## License

Apache-2.0。见 [LICENSE](LICENSE)。
