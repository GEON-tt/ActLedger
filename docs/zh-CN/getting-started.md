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
```

CLI 批准默认是 `app_asserted`。`--assurance channel_verified` 或 `user_signed` 只用于本地测试，回执会标成 `simulated`，因为 CLI 并不做真实的渠道身份确认。

把代理放在 MCP 服务器前面：

```bash
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

接着看 [mcp-proxy.md](mcp-proxy.md)、[sdk-typescript.md](sdk-typescript.md)、[sdk-python.md](sdk-python.md)。

## 回执用来做什么

回执写明谁发起、哪条规则生效、谁以什么保证等级批准、批准的载荷是什么、实际执行的载荷是什么。哈希链证明这份记录事后没有被改。它不证明 agent 的每个动作都记下来了。见 [guarantees.md](guarantees.md)。

## 发布后

包发到 npm 之后：

```bash
npx -y @actledger/cli init
npx -y @actledger/mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

字段规则见[规范](../../spec/zh-CN/README.md)。各部分怎么拼在一起见 [architecture.md](architecture.md)。
