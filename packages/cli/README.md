[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/cli/README.md) | [简体中文](#简体中文)

# @actledger/cli

Initialize a local ledger, approve tasks, and export or verify receipts.

```bash
npm install @actledger/cli
npx actledger init
npx actledger verify receipts.jsonl --keys .actledger/keys.json
```

`init` writes a signing key, the ledger, and the default policy under `.actledger/`. `verify` exits 0 on success.

Repository guide: <https://github.com/GEON-tt/ActLedger/blob/main/README.md>. Protocol: <https://github.com/GEON-tt/ActLedger/blob/main/spec/README.md>.

## 简体中文

命令行初始化本地账本，批准任务，并导出、校验回执。

`init` 在 `.actledger/` 生成签名密钥、账本和默认策略。`verify` 成功时退出码为 0。

仓库说明：<https://github.com/GEON-tt/ActLedger/blob/main/README.zh-CN.md>。协议：<https://github.com/GEON-tt/ActLedger/blob/main/spec/zh-CN/README.md>。
