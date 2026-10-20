[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/server/README.md) | [简体中文](#简体中文)

# @actledger/server

Single-tenant ActLedger server: the ledger and signing key stay here, agents call `/v1` with a bearer key, and people approve in a password + TOTP console.

```bash
npx @actledger/server init --data ./actledger-data --policy policy.yaml
npx @actledger/server serve --data ./actledger-data --host 127.0.0.1 --port 4400
```

The binary name is `actledger-server`. Data defaults to `$ACTLEDGER_DATA` or `./actledger-data`.

```text
actledger-server init [--data dir] [--policy file.yaml]
actledger-server serve [--data dir] [--host 127.0.0.1] [--port 4400] [--trust-proxy] [--public-url url] [--sweep-ms 5000]
actledger-server user add <username> --principal <id> [--data dir] [--password-stdin] [--no-qr] [--json]
actledger-server user reset-totp <username> [--data dir] [--no-qr] [--json]
actledger-server user list [--data dir] [--json]
actledger-server agent-key create --agent <id> --principal <id> [--principal <id> ...] [--label text] [--data dir] [--json]
actledger-server agent-key revoke <key id> [--data dir]
actledger-server agent-key list [--data dir] [--json]
actledger-server audit-key create [--label text] [--data dir] [--json]
actledger-server audit-key revoke <key id> [--data dir]
actledger-server help
```

Docker and Caddy: <https://github.com/GEON-tt/ActLedger/blob/main/deploy/README.md>. HTTP API: <https://github.com/GEON-tt/ActLedger/blob/main/spec/http.md>.

## 简体中文

单租户 ActLedger 服务器：账本和签名私钥留在这里，agent 用 bearer key 调 `/v1`，人在密码 + TOTP 审批台上批准。

Docker 与 Caddy：<https://github.com/GEON-tt/ActLedger/blob/main/deploy/README.zh-CN.md>。HTTP API：<https://github.com/GEON-tt/ActLedger/blob/main/spec/zh-CN/http.md>。
