[English](../../en/scenarios/approval-console.md) | [简体中文](approval-console.md)

# 审批台

## 放在哪里

`actledger serve` 不会把记录式接入变成强制式（[保证边界](../guarantees.md)）。它是 `127.0.0.1` 上的本地页面，人在这里批准或拒绝上面任一接入方式产生的任务。它在 agent 进程外面，所以 agent 不能批准自己的调用。这里做出的批准是 `app_asserted`：应用声称用户确认过，这不是渠道身份核验。

## 最小代码

取自 [`packages/cli/src/main.ts`](../../../packages/cli/src/main.ts)。

```bash
pnpm actledger init
pnpm actledger serve --dir .actledger
# actledger serve http://127.0.0.1:4319
# login: http://127.0.0.1:4319/login?token=…
```

### 再次登录

同一个 URL 在重启后、多次登录时都有效。每次登录开一个新会话。token 文件是 `.actledger/serve.token`，权限 0600。

下面的命令只打印 URL，不启动服务：

```bash
pnpm -s actledger serve --print-login --dir .actledger
```

URL 里的端口来自 `--port`（默认 4319），所以服务在别的端口时要传同样的 `--port`。`-s` 让 pnpm 不打印自己的横幅，这一行可以直接 `open "$(…)"`。

demo 的审批台：

```bash
pnpm -s actledger serve --print-login --dir examples/chat-approval/out/ledger --port 4328
```

列表自动刷新时如果会话已经失效，页面显示 `Session ended. Run actledger serve --print-login and open the URL again.`

会话在空闲 12 小时或创建 24 小时后过期。登出只结束当前会话。URL 仍然可用。

### 轮换 token

```bash
pnpm actledger serve --rotate-token --dir .actledger                 # rotate, then start
pnpm -s actledger serve --print-login --rotate-token --dir .actledger # rotate and print, no server
```

轮换之后，旧 URL 和所有已有会话都失效。另一个进程里正在运行的 serve 会在下一次请求时拒绝旧 token。`--one-time-login` 使用只在内存里的 token，只能用一次，不写文件。它不能和 `--token-file`、`--rotate-token` 或 `--print-login` 一起用。`--print-login` 不能和 `--approver` 一起用。

### 页面上有什么

三个标签：Pending approvals、Recent decisions、All tasks。页面每 3 秒从 `GET /api/tasks` 刷新。关掉 JavaScript 之后，标签链接仍然可以切换列表。

任务页有一块 `You are approving`（action、args 和 `presented_hash`）、一块 Decision，以及 Timeline。时间线标签是 requested、pending approval、approved by policy、approved、denied by policy、rejected、claimed、completed、failed、unknown、expired、revoked、drafted。

拒绝必须写理由，最长 2000 个字符。CLI 的写法是 `actledger reject <task> --note <reason>`。

### 保证等级

| 等级 | 从哪来 |
| --- | --- |
| `policy` | `allow` 规则批准了它，审批人是 `policy:<rule id>` |
| `app_asserted` | 审批台、签名 webhook 链接，或不带 `--assurance` 的 `actledger approve` |
| `channel_verified` | 这一版只有 `actledger approve --assurance channel_verified`，标为 `simulated` |
| `user_signed` | 只有 `actledger approve --assurance user_signed`，标为 `simulated` |

### 为什么 Approve 是禁用的

任务的最低保证高于 `app_asserted` 时，页面只能记录 `app_asserted`，引擎会以 `assurance_insufficient` 拒绝，所以按钮禁用。页面显示：`Approve is disabled: this action needs <min> assurance, and this page can only record app_asserted. Approve it with the CLI (actledger approve <id> --assurance <min>) or a verified channel. You can still reject it here with a reason.`

最低保证来自规则的 `approval.min_assurance`。动作级别是 `send`、`spend` 或 `delete`，并且规则没有写 `min_assurance` 时，会自动抬到 `channel_verified`（[evaluate.ts](../../../packages/core/src/policy/evaluate.ts)）。默认策略的 `email.send` 规则显式要求 `channel_verified`。

可以做的事：在这里写理由拒绝（拒绝不检查保证等级）；用 `actledger approve <id> --assurance channel_verified` 批准（回执标为 simulated；见[保证边界](../guarantees.md)）；或者有意在规则上写 `min_assurance: app_asserted`。

其他禁用原因：任务需要 step-up，只能由 CLI 的 `--step-up` 提供，这次批准同样是 simulated；任务的渠道不含 `web`，批准和拒绝都禁用；`--approver` 不是任务的 principal，批准和拒绝也都禁用。

## 策略

`actledger init` 会把默认策略写到 `.actledger/policy.yaml`（[源码](../../../packages/core/src/default-policy.ts)）。不改这个文件时，经过闸门的工具调用是 `tool.<name>`，它不在 `actions` 里，没有规则匹配，于是走 `defaults.unknown_action: require_approval`：任务等待批准（rule id `default:require_approval`），保证等级 `app_asserted`，可以从 `cli` 或 `web` 批。请在这个文件上改，不要另写一份。策略文件整份生效；`defaults` 里省略的键回落到引擎值，其中 `approval.channels` 的回落值是空列表，也就是只有 CLI。

对这一页来说，`approval.channels` 必须包含 `web`。默认文件已经包含。自己写的文件如果省略 `channels`，就只有 CLI。需要签名链接时再加 `webhook_link`。`allow_edit` 为 true 时，编辑只能用 `actledger approve <id> --edit`。渠道列表在任务创建时固定。之后改策略只影响新任务。

## 下一步

- [审批](../approval.md) 说明 cookie、Origin 检查、webhook，以及签名链接的完整规则。
- [保证边界](../guarantees.md)
- [examples/chat-approval](../../../examples/chat-approval/README.zh-CN.md)
