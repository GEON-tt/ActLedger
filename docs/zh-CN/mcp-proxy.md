[English](../en/mcp-proxy.md) | [简体中文](mcp-proxy.md)

# MCP 代理

`@actledger/mcp-proxy` 是一个 stdio MCP 服务器，放在另一个 MCP 服务器前面。agent 只和代理说话。转发 `tools/call` 之前，代理先问本地账本。调用会被放行、挂起等待批准，或拒绝。这次迁移写成签名回执。

对代理暴露出来的工具，这是强制式接入：agent 没有直连那台上游。能到达同一服务的 shell、通用 HTTP 客户端或浏览器仍然可以绕过代理。工具名含 `shell`、`exec`、`http`、`fetch` 或 `browser` 时，代理会警告。

## 从克隆运行

```bash
pnpm install
pnpm actledger init
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

在 MCP 客户端配置里，`--ledger` 用绝对路径。发布之后同一条命令是 `npx -y @actledger/mcp-proxy`。

代理还接受 `--upstream "<cmd>"`、`--config <file>`、`--principal`、`--name`、`--approval-wait`。`--upstream` 不经过 shell 拆分。

## MCP 客户端配置

在 MCP 客户端（Cursor、Claude Desktop 等）里指向这份源码。`--ledger` 必须是绝对路径。

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

发布之后：

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

## 一次调用里发生什么

1. 工具参数成为 `payload.args`。配置了内容字段时，它可以挪到 `payload.content`。
2. 策略选择 `allow`、`require_approval`、`deny` 或 `draft_only`。没有 `actions` 条目的工具走 `defaults.unknown_action`（除非你改掉，否则是 `require_approval`）。
3. `allow` 时，代理认领任务（`approved` → `executing`）再转发。
4. `require_approval` 时，代理返回待批准任务。默认的后续工具是 `check_task`。有人执行 `actledger approve` 之后，下一次 `check_task` 会认领并转发。
5. 暴露出来的工具被叠成覆盖声明 `mode: enforced`、`via: mcp-proxy`。这个叠加不会写回 `policy.yaml`。

在另一个终端批准：

```bash
pnpm actledger tasks --state pending_approval
pnpm actledger approve tsk_...
```

## 配置示意

```yaml
version: 1
name: mail
ledger: .actledger
principal: local-user
agent_id: mcp-proxy:mail
upstream:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
approval:
  wait_ms: 8000
tools:
  send_email:
    action: email.send
    content:
      field: body
      content_type: text/plain
```

`tools` 把上游工具名映射到 ActLedger 的 `action`。没列出的上游工具仍然走未知动作的默认值。

可运行的例子在 `examples/mcp-proxy-email/`。用 `pnpm exec tsx examples/mcp-proxy-email/run.ts` 启动。

场景步骤：[一个 MCP 服务器](scenarios/mcp-server.md)。

载荷和策略的规范性规则在[规范](../../spec/zh-CN/payload.md)和 [policy.md](../../spec/zh-CN/policy.md)。代理自己的映射是资料性的，校验器不依赖它。
