[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/core/README.md) | [简体中文](#简体中文)

# @actledger/core

ActLedger protocol core: receipts, payloads, the state machine, policy, verification, and the SQLite ledger.

```bash
npm install @actledger/core
```

```ts
import { readFileSync } from "node:fs";
import { verifyJsonl } from "@actledger/core";

const report = verifyJsonl(
  readFileSync("receipts.jsonl", "utf8"),
  JSON.parse(readFileSync("keys.json", "utf8")),
);
if (!report.ok) throw new Error(report.failure?.reason);
```

Repository guide: <https://github.com/GEON-tt/ActLedger/blob/main/README.md>. Protocol: <https://github.com/GEON-tt/ActLedger/blob/main/spec/README.md>.

## 简体中文

ActLedger 协议核心：回执、载荷、状态机、策略、校验和 SQLite 账本。

```bash
npm install @actledger/core
```

仓库说明：<https://github.com/GEON-tt/ActLedger/blob/main/README.zh-CN.md>。协议：<https://github.com/GEON-tt/ActLedger/blob/main/spec/zh-CN/README.md>。
