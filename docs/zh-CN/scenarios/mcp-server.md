[English](../../en/scenarios/mcp-server.md) | [简体中文](mcp-server.md)

# 一个 MCP 服务器

## 放在哪里

这是**强制式**路径（[保证边界](../guarantees.md)）。让 MCP 服务器经 `@actledger/mcp-proxy` 启动，并把客户端指到代理。agent 没有直连那台服务器，所以对暴露工具的 `tools/call` 在账本认领任务之前不能运行。暴露的工具在回执上声明 coverage `mode: enforced`、`via: mcp-proxy`；这个叠加不会写进 `policy.yaml`。能到达同一服务的 shell、HTTP 客户端或浏览器仍然可以绕过它。网络和凭证隔离由你自己保证。工具名含 `shell`、`exec`、`http`、`fetch` 或 `browser` 时，代理会警告。

## 最小代码

取自 [MCP 代理](../mcp-proxy.md) 和 [`examples/mcp-proxy-email/proxy.config.yaml`](../../../examples/mcp-proxy-email/proxy.config.yaml)。

### 从终端

```bash
pnpm install
pnpm actledger init
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

### MCP 客户端配置

`--ledger` 必须是绝对路径。

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

### 把工具名映射成动作

这里省掉了示例里的 upstream 命令。账本看到的是这份映射。

```yaml
version: 1
name: mail
ledger: .actledger
principal: local-user
agent_id: mcp-proxy:mail
approval:
  wait_ms: 3000
tools:
  send_email:
    action: email.send
    content:
      field: body
      content_type: text/plain
  list_inbox:
    action: email.read
```

调用在等批准时，代理返回 pending 任务。客户端接着用 `{ task_id }` 调用 `check_task`。批准之后，这次调用认领任务并转发。[`examples/mcp-proxy-email/run.ts`](../../../examples/mcp-proxy-email/run.ts) 每秒做一次。

用 `--config <file>` 传入配置文件。其余参数是 `--upstream`、`--upstream-cwd`、`--principal`、`--name` 和 `--approval-wait`。参数列表和调用顺序见 [MCP 代理](../mcp-proxy.md)。

代理的默认 principal 是 `local-user`。审批台不带 `--approver` 启动时，以任务的 principal 审批，所以不需要再配别的。

`pnpm exec tsx examples/mcp-proxy-email/run.ts` 是可运行示例。它打印的批准命令带有 `--assurance channel_verified`，原因见下面的策略。

## 策略

`actledger init` 会把默认策略写到 `.actledger/policy.yaml`（[源码](../../../packages/core/src/default-policy.ts)）。代理不是 ToolGate。不改这个文件时，未映射的上游工具的 action type 就是上游工具名本身（例如 `read_file`），不是 `tool.<name>`。映射过的工具用 `tools.<name>.action`。这个名字不在 `actions` 里时，没有规则匹配，于是走 `defaults.unknown_action: require_approval`：任务等待批准（rule id `default:require_approval`），保证等级 `app_asserted`，可以从 `cli` 或 `web` 批。请在这个文件上改，不要另写一份。策略文件整份生效；`defaults` 里省略的键回落到引擎值，其中 `approval.channels` 的回落值是空列表，也就是只有 CLI。

默认策略下，没有声明的工具都等待批准。action 不在 `actions` 里时，代理会打出 `warning: action … is not in policy actions; defaults.unknown_action will apply`。

把只读的上游工具加在已有的 `actions:` 键下面：

```yaml
actions:
  # existing entries stay
  read_file:
    level: read   # the default read-allow rule now allows it
```

`email.read` 和 `email.send` 在默认策略里已经声明。`email.read` 命中 `read-allow`，会被放行。`email.send` 命中 `email-external-approve`，需要 `channel_verified`（[evaluate.ts](../../../packages/core/src/policy/evaluate.ts)），所以审批台不能批准。`examples/mcp-proxy-email/policy.yaml` 的渠道只有 `[cli]`。

## 下一步

- [MCP 代理](../mcp-proxy.md)
- [examples/mcp-proxy-email](../../../examples/mcp-proxy-email)
- [审批台](approval-console.md)
