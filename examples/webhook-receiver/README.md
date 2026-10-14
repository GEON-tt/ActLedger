[English](README.md) | [简体中文](README.zh-CN.md)

# Webhook receiver

A minimal receiver for the `actledger serve` webhook channel. It uses `node:http` and `verifyWebhook`. No API key.

## Steps

From the repository root:

```bash
DIR=$(mktemp -d)
pnpm actledger init --dir "$DIR" --policy examples/webhook-receiver/policy.yaml
cp examples/webhook-receiver/channels.yaml "$DIR/channels.yaml"
export ACTLEDGER_WEBHOOK_SECRET=dev-secret

# terminal 1
pnpm exec tsx examples/webhook-receiver/run.ts
# terminal 2, same ACTLEDGER_WEBHOOK_SECRET
pnpm actledger serve --dir "$DIR" --port 4319
# terminal 3
pnpm exec tsx examples/webhook-receiver/request.ts "$DIR"
```

Terminal 1 prints `task.pending_approval tsk_… state=pending_approval` and `approve_url: http://127.0.0.1:4319/…`. Open that link in a browser and approve on the confirmation page. Terminal 1 then prints `task.approved …`. `pnpm actledger tasks --dir "$DIR"` shows the state.

## Point channels.yaml here

Set `url` to `http://127.0.0.1:<PORT>/hook`. Set `secret_env` to a variable name, and give serve and this receiver the same value for that variable. When `events` is omitted, the default is only `task.pending_approval`. `approve_url` is a string only when the task policy `approval.channels` includes `webhook_link`. Otherwise it is `null`.

## Notes

`approve_url` is a one-time bearer link. It lasts 15 minutes. Do not post it to a public channel. Serve listens only on 127.0.0.1. This receiver binds only 127.0.0.1. If the secret is missing, serve skips that channel and writes `missing_secret_env` to `notify.log`.

Channels, the signature, and signed links: [approval §4–§6](../../docs/en/approval.md#4-channelsyaml).
