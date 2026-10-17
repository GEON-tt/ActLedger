[English](../en/approval.md) | [简体中文](approval.md)

# 审批

ActLedger 的审批发生在 agent 外面。这一页说明本地 CLI、回环审批页和签名 webhook。

## 1. 渠道

任务在创建时记下当时合并后的 `approval.channels`。`approve` 和 `reject` 都带一个渠道：

| 渠道 | 来源 |
| --- | --- |
| `cli` | `actledger approve` / `actledger reject` |
| `web` | `actledger serve` 的页面 |
| `webhook_link` | webhook 里的签名链接 |

引擎只在该渠道属于任务列表时接受决定。空列表，或策略没写 `channels`，表示 `[cli]`。否则返回 `403 channel_not_allowed`，并且不写回执。列表写在任务上。之后改 `policy.yaml` 只影响新任务。

`actledger init` 的默认策略渠道是 `[cli, web]`。`webhook_link` 需要你自己加上。更早建的目录仍是 `[cli]`。在 `defaults.approval.channels` 里加上 `web`（需要链接再加 `webhook_link`），然后新建任务。已经 pending 的任务保留旧列表；网页不允许时，详情页会提示。

## 2. CLI

`actledger approve` 和 `actledger reject` 记录渠道 `cli`。见[入门](getting-started.md)。审批人是任务的 principal。高于 `app_asserted` 的保证，或 `--step-up`，会标成 `simulated`。

## 3. 本地页面

```bash
actledger serve --dir .actledger --port 4319 --approver <principal>
```

进程只绑定 `127.0.0.1`，没有参数可以改。它打印源站和登录 URL。token 存在 `.actledger/serve.token`（权限 0600，可用 `--token-file <path>` 指定），重启后仍有效，可以反复登录，每次登录开一个新会话。`actledger serve --print-login` 打印同一个 URL 后退出，不启动服务。`actledger serve --rotate-token` 写入新 token，旧登录 URL 和所有已有会话立即失效，然后启动服务并打印新 URL。`--one-time-login` 保留旧行为：token 只在内存里，只能用一次，不写盘。

Cookie 名是 `actledger_session`，属性为 `HttpOnly`、`SameSite=Strict`、`Path=/`。不设 `Secure`，也不设 `Max-Age`：这个服务在回环上使用明文 HTTP，浏览器对 `http://127.0.0.1` 的 `Secure` cookie 不可靠。它是会话 cookie。服务端在空闲 12 小时或创建后 24 小时过期，以先到者为准。

会话里的 POST 带本会话的 CSRF token。请求带 `Origin` 时，它必须是允许的来源（`http://127.0.0.1:<port>`、`http://localhost:<port>`，或 `public_url` 的 origin）。`Origin` 缺失或为 `null`（部分 Safari 版本）时，只有 `Sec-Fetch-Site` 是 `same-origin` 或 `none`，或 `Referer` 来自允许的来源，才会接受；CSRF token 和 `SameSite=Strict` 会话 cookie 仍然必需。如果带了 `Sec-Fetch-Site`，只能是 `same-origin` 或 `none`。每个请求的 `Host` 必须在允许集合里，否则返回 421。任何 GET 都不会批准或拒绝，打开登录 URL 不需要 `Origin`。

不传 `--approver` 时，页面以 `task.principalId` 审批，和 CLI 一样。这个默认值不是应用名 `local`。传了 `--approver` 就原样交给引擎。只有 principal 相同的任务能批，其余返回 `403 approver_mismatch`。

页面不能改 payload，不能做 step-up，只能给出 `app_asserted`。任务要求更高保证或 step-up 时，批准按钮禁用。除非渠道本身不允许，拒绝仍然可用。拒绝必须写理由：页面没有理由时返回 `400 reason_required`，`actledger reject` 必须带 `--note`。

## 4. channels.yaml

`actledger init` 会写入注释掉的 `.actledger/channels.yaml` 示例，并创建 `keys/link-hmac.key`。`actledger serve` 读取这个文件。文件不存在，或只有注释，就是零个渠道。语法或结构错误会拒绝启动。环境变量缺失或为空时跳过该渠道并记日志，其他渠道照常发送。

```yaml
public_url: http://127.0.0.1:4319
channels:
  - name: team-webhook
    type: webhook
    url: https://example.com/actledger-hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    events: [task.pending_approval, task.approved, task.rejected]
    include_payload: false
```

| 字段 | 含义 |
| --- | --- |
| `public_url` | 可选。`http` 或 `https`，不能带 query 或 hash。链接和详情 URL 用它。省略时 serve 使用 `http://127.0.0.1:<实际端口>`。非回环主机只打警告。监听仍然只在 127.0.0.1。 |
| `name` | 小写标识，不可重复 |
| `type` | 只能是 `webhook` |
| `url` | `http` 或 `https` 地址 |
| `secret_env` | 环境变量名。不要把密钥本身写进文件 |
| `events` | 可选。默认 `[task.pending_approval]`。允许 `task.pending_approval`、`task.approved`、`task.rejected` |
| `include_payload` | 可选布尔值，默认 `false` |

`task.pending_approval` 在任务进入该状态时发送，包括 serve 第一次看到的、已经 pending 的任务。`task.approved` 和 `task.rejected` 只在人工决定时发送（`approvalId` 有值）。策略自动允许和自动拒绝不发这两种事件。两次轮询之间从 pending 直接变成 approved 时，只发 `task.approved`。

## 5. Webhook 签名

每次投递的 JSON 是 `WebhookEvent` 信封 `{id, type, created_at, data}`。重试保持同一个 `id` 和 body，并用新的时间戳重新签名。

```
ActLedger-Signature: t=<unix 秒>,v1=<hex hmac>
ActLedger-Event: task.pending_approval
ActLedger-Delivery: evt_...
```

HMAC-SHA256 的密钥是渠道 secret。它覆盖 UTF-8 字符串 `t + "." + 原始 body`。接收方应允许 300 秒窗口。`ActLedger-Delivery` 是事件 id，用来去重。另外还有 `Content-Type: application/json` 和 `User-Agent: actledger-serve/0.1.0`。

```ts
import { verifyWebhook } from "@actledger/sdk/webhook";

const event = verifyWebhook(
  rawBody,
  request.headers["actledger-signature"],
  process.env.ACTLEDGER_WEBHOOK_SECRET ?? "",
);
```

一个会打印 approve_url 的可运行接收端见 [examples/webhook-receiver](../../examples/webhook-receiver)。

`data` 包含 `task_id`、`state`、`action`（`type`、`level`、`resource`）、`payload_hash`、`intent_commit`、`task_created_at`、`approve_url`、`detail_url`。只有 `task.pending_approval` 且任务允许 `webhook_link` 时，`approve_url` 才是签名链接，否则为 `null`。`detail_url` 始终需要会话。人工决定会加上 `decided_by: "user"`。`include_payload: true` 时额外带上 `data.payload` 和 `data.intent`；解密失败则为 `null`。

一次投递最多 4 次（首次加 3 次重试）。等待时间为 `retryBaseMs * 2^(n-1)`（默认 1 秒、2 秒、4 秒）。每次尝试 10 秒超时。2xx 成功。网络错误、超时、5xx 和 429 会重试。其他 4xx 立即失败。3xx 视为失败，不跟随重定向。

`.actledger/notify.log` 是 JSON Lines，权限 0600。一行类似：

```json
{"ts":"...","event_id":"evt_...","event":"task.pending_approval","task_id":"tsk_...","channel":"team-webhook","attempt":1,"outcome":"retry","status":503,"url_host":"example.com"}
```

`outcome` 是 `delivered`、`retry`、`failed` 或 `skipped`。失败可以带 `error`（错误消息，不是 body）。跳过带 `reason: "missing_secret_env"` 和 `secret_env`（变量名）。日志不记录 body、payload、intent、secret 或 `approve_url`。目标只记 `url_host`。投递记录不进账本。

## 6. 签名链接

策略的 `approval.channels` 里没有 `webhook_link` 时，webhook 的 `approve_url` 是 `null`。链接有效 15 分钟。密钥是 `keys/link-hmac.key`（32 字节原始密钥，权限 0600），与回执密钥和数据密钥分开。链接绑定任务 id 和 payload hash，并且只能用一次。serve 在调用引擎之前就把它标成已用，所以批准失败也会消耗链接。已用签名以 SHA-256 存在 `.actledger/link-used.jsonl`（权限 0600），不存原始签名。删掉 `keys/link-hmac.key` 再重启 serve，未使用的链接全部失效。

链接指向 `public_url`。serve 仍然只监听 127.0.0.1。从别的机器访问要你自己转发，这一轮不提供。链接是 bearer 凭据，不要发到公开频道。

确认页用一次性表单 nonce，加上和会话页相同的 Origin 规则（缺 Origin 时需要 `Sec-Fetch-Site: same-origin`/`none` 或允许来源的 `Referer`）。它不种会话 cookie。链接拒绝也必须写理由，缺理由不会消耗链接。决定的渠道是 `webhook_link`，保证是 `app_asserted`，审批人始终是任务 principal。链接不使用 `--approver`。

## 7. app_asserted 的含义

网页和链接审批表示本应用声称用户点了确认。这不是渠道身份核验。`simulated` 为 `false`，因为回执没有声称更高等级。本地测试里要更高等级，用 CLI 的 simulated 保证。真正的 `channel_verified` 或 `user_signed` 渠道不在这一轮。
