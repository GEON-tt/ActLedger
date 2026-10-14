[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/sdk/README.md) | [简体中文](#简体中文)

# @actledger/sdk

Request a task, wait for approval, and finish execution with `Ledger`. `npm install @actledger/sdk`

```ts
import { Ledger } from "@actledger/sdk";
const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const task = await ledger.request({
  principalId: "u_1", action: { type: "calendar.create" },
  payload: { action: "calendar.create", args: { title: "standup" } },
  intent: "create a standup",
});
const ready = await task.wait({ timeoutMs: 60_000 });
if (ready.state === "approved") {
  const run = await ready.claim();
  await run.complete({ executedPayload: run.approvedPayload });
}
ledger.close();
```

Repository guide: <https://github.com/GEON-tt/ActLedger/blob/main/README.md>. Protocol: <https://github.com/GEON-tt/ActLedger/blob/main/spec/README.md>.

## 简体中文

用 `Ledger` 发起任务、等待批准并完成执行。`npm install @actledger/sdk`

仓库说明：<https://github.com/GEON-tt/ActLedger/blob/main/README.zh-CN.md>。协议：<https://github.com/GEON-tt/ActLedger/blob/main/spec/zh-CN/README.md>。
