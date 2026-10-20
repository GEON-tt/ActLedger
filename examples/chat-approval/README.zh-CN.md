# 对话审批 demo

一条命令在同一个进程里启动本地对话页和 ActLedger 审批台。`send_note` 在工具门里面等审批台批准，批准之后才往 `out/outbox.jsonl` 追加一行。每一轮结束，页面显示任务 id、审批人、回执 hash，以及进程内的 verify 结果。

## 运行

在仓库根目录：

```bash
pnpm install
pnpm demo
```

终端会打印两个 URL 和登录链接，并打开浏览器。`ACTLEDGER_DEMO_NO_OPEN=1` 时不打开浏览器。审批台默认端口 4328，对话页默认端口 4340，分别用 `ACTLEDGER_DEMO_SERVE_PORT` 和 `ACTLEDGER_DEMO_CHAT_PORT` 修改。

数据在 `examples/chat-approval/out/`（已 gitignore）。`ACTLEDGER_DEMO_FRESH=1` 会删掉这个目录再重新开始。登录链接重启后仍然有效（`out/ledger/serve.token`）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `ACTLEDGER_DEMO_PROVIDER` | `fake`（默认）、`cursor`、`claude` 或 `openai` |
| `CURSOR_API_KEY` | Cursor provider 需要 |
| `ANTHROPIC_API_KEY` | Claude provider |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude provider |
| `ACTLEDGER_DEMO_CLAUDE_LOGIN` | 本机 Claude Code 已经登录时设为 `1` |
| `OPENAI_API_KEY` | OpenAI provider 需要 |
| `OPENAI_DEFAULT_MODEL` | 可选的 OpenAI 模型 id |
| `ACTLEDGER_DEMO_SERVE_PORT` | 审批台端口（默认 4328） |
| `ACTLEDGER_DEMO_CHAT_PORT` | 对话端口（默认 4340） |
| `ACTLEDGER_DEMO_NO_OPEN` | 设为 `1` 则不打开浏览器 |
| `ACTLEDGER_DEMO_FRESH` | 设为 `1` 则启动前清空 `out/` |

key 只从环境变量读取，也可以放在 `examples/chat-approval/.env`（已 gitignore，不要提交）。demo 不会打印或保存 key。

## 连接到远端服务器

同时设置 `ACTLEDGER_URL` 和 `ACTLEDGER_API_KEY`。这时 demo 不创建 `out/ledger`，也不启动本地 `actledger serve`。发件箱仍写在 agent 机器的 `out/outbox.jsonl`。终端打印远端审批台地址，并且只打开对话页。

服务器上用 `examples/chat-approval/policy.yaml` 初始化，审批人账号带 `--principal u_1`，key 用 `agent-key create --agent chat-approval --principal u_1`。`tool.send_note` 是 `level: write`、`min_assurance: app_asserted`，审批台可以直接批。两个变量只设一个会报错，并指出缺的是哪一个。

## gate 放在哪

四种都是 recorded 接入。

- **fake** 和 **cursor** 在工具函数内部调用 `createToolGate`。这是 wait 模式，超时 15 分钟，每 250 ms 轮询一次。
- **claude** 在适配器的 `canUseTool` 里调用 gate（wait 模式）。工具函数体只用原始写入，不会再开第二个任务。
- **openai** 在适配器的 `needsApproval` 里调用 gate。OpenAI 适配器只接受 defer 模式，所以这里用 `resolveInterruptions` 每 1 秒查一次，最长 15 分钟。

## 手动验证

### Cursor

1. 设置 `CURSOR_API_KEY` 和 `ACTLEDGER_DEMO_PROVIDER=cursor`，然后 `pnpm demo`。
2. 发「列出笔记」。不出现等待审批。汇总里审批人是 `policy:list-notes-allow`，verify OK。
3. 发「帮我发一条笔记：明天下午三点开会」。出现等待审批和任务链接。工具行显示 `send_note`，不是 `mcp`。
4. 点链接到审批台批准。对话继续，`out/outbox.jsonl` 多一行。汇总里审批人是 `u_1 via web`，有 receipt hash，verify OK。
5. 再发一条，这次在审批台填写理由后拒绝。回复说没有发送，outbox 不变。汇总显示 rejected，并显示「已记录拒绝理由」。

### Claude

1. 设置 `ACTLEDGER_DEMO_PROVIDER=claude`，并设置 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 或 `ACTLEDGER_DEMO_CLAUDE_LOGIN=1` 之一，然后 `pnpm demo`。
2. 发「列出笔记」。不出现等待审批。汇总里审批人是 `policy:list-notes-allow`，verify OK。
3. 发「帮我发一条笔记：明天下午三点开会」。出现等待审批和任务链接。工具行显示 `send_note`，不是 `mcp`。
4. 点链接到审批台批准。对话继续，`out/outbox.jsonl` 多一行。汇总里审批人是 `u_1 via web`，有 receipt hash，verify OK。
5. 再发一条，这次在审批台填写理由后拒绝。回复说没有发送，outbox 不变。汇总显示 rejected，并显示「已记录拒绝理由」。

### OpenAI

1. 设置 `OPENAI_API_KEY` 和 `ACTLEDGER_DEMO_PROVIDER=openai`（`OPENAI_DEFAULT_MODEL` 可选），然后 `pnpm demo`。
2. 发「列出笔记」。不出现等待审批。汇总里审批人是 `policy:list-notes-allow`，verify OK。
3. 发「帮我发一条笔记：明天下午三点开会」。出现等待审批和任务链接。工具行显示 `send_note`，不是 `mcp`。
4. 点链接到审批台批准。对话继续，`out/outbox.jsonl` 多一行。汇总里审批人是 `u_1 via web`，有 receipt hash，verify OK。
5. 再发一条，这次在审批台填写理由后拒绝。回复说没有发送，outbox 不变。汇总显示 rejected，并显示「已记录拒绝理由」。

## CI

`pnpm test` 只跑 fake provider。Cursor、Claude、OpenAI 在 CI 里不会被调用，只做类型检查。

## 安全说明

这是本地 demo，不是带认证的产品。对话服务没有登录，同一台机器上的任何程序都能用它。它只监听 127.0.0.1，并拒绝 Host 不是 `127.0.0.1:<port>` 或 `localhost:<port>` 的请求，用来防 DNS rebinding。它只接受 JSON 格式的 POST，不转发任何请求。没有 Origin 头的请求会放行：Host 检查加上 JSON content-type 可以挡住跨站表单，因为那种表单发不出 JSON，会先触发 CORS 预检，而这个服务不回 CORS 头。

审批台沿用 `actledger serve` 的登录、CSRF 和 Origin 规则。对话页不会显示审批台的登录 token。

## Claude 的已知限制

没法离线判断 Claude Code 是否已经登录，所以需要设 `ACTLEDGER_DEMO_CLAUDE_LOGIN=1` 明确表示已经登录。
