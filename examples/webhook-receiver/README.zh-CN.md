[English](README.md) | [简体中文](README.zh-CN.md)

# Webhook 接收端

`actledger serve` webhook 渠道的最小接收端。只用 `node:http` 和 `verifyWebhook`，不需要 API key。

## 步骤

在仓库根目录：

```bash
DIR=$(mktemp -d)
pnpm actledger init --dir "$DIR" --policy examples/webhook-receiver/policy.yaml
cp examples/webhook-receiver/channels.yaml "$DIR/channels.yaml"
export ACTLEDGER_WEBHOOK_SECRET=dev-secret

# 终端 1
pnpm exec tsx examples/webhook-receiver/run.ts
# 终端 2，同一个 ACTLEDGER_WEBHOOK_SECRET
pnpm actledger serve --dir "$DIR" --port 4319
# 终端 3
pnpm exec tsx examples/webhook-receiver/request.ts "$DIR"
```

终端 1 打印 `task.pending_approval tsk_… state=pending_approval` 和 `approve_url: http://127.0.0.1:4319/…`。浏览器打开链接，在确认页点批准。终端 1 再打印 `task.approved …`。`pnpm actledger tasks --dir "$DIR"` 能看到状态。

## 把自己的 channels.yaml 指过来

`url` 填 `http://127.0.0.1:<PORT>/hook`。`secret_env` 填一个变量名，serve 和接收端两边的同名变量值一致。`events` 不写时默认只有 `task.pending_approval`。要拿到 `approve_url`，任务的策略 `approval.channels` 必须含 `webhook_link`，否则是 `null`。

## 注意

`approve_url` 是一次性 bearer 链接，15 分钟有效，不要贴到公开频道。serve 只监听 127.0.0.1。接收端也只绑定 127.0.0.1。secret 缺失时 serve 跳过该渠道并在 `notify.log` 记 `missing_secret_env`。

渠道、签名和签名链接见[审批 §4–§6](../../docs/zh-CN/approval.md#4-channelsyaml)。
