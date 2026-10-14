[English](../en/sdk-typescript.md) | [简体中文](sdk-typescript.md)

# TypeScript SDK

`@actledger/sdk` 是进程内客户端。在本仓库里它使用 `@actledger/core` 的本地 SQLite 账本。还没有 HTTP 传输。以后的服务端应通过 `Transport` 接进来。

在克隆里依赖 workspace 包。发布之后：`npm install @actledger/sdk`。

## request、wait、claim、complete

```ts
import { Ledger } from "@actledger/sdk";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const task = await ledger.request({
  principalId: "u_1",
  action: { type: "calendar.create" },
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

`request` 写下 `prepared`，并在同一次流程里走完策略决定。`wait` 轮询到任务离开 `pending_approval`。`claim` 把 `approved` 推进到 `executing`，只能成功一次。第二次是 `already_claimed`。

认领之后进程停了，或者执行期限到了，任务变成 `unknown`。这个任务还没解决时，不要用同一个幂等键再开一次。用 `complete` 或 `fail` 报告实际发生了什么，包括对账。

`complete` 比较执行载荷和批准载荷。`allowed_drift` 里的路径可以不同。默认的 `strict` 内容模式里，其余差异会让任务以 `content_mismatch` 失败。SDK 的 `strictContent` 默认 `true`，会在调用 complete 之前再查一次。

0.2 回执上的 `intent` 是承诺。明文留在 secrets 文件里，不进回执。

## 包住一个工具

`ledger.guard` 在函数外面跑 request、wait、claim、complete。工具实现在你手里时用它。这是记录式接入：模型仍然可以调用另一个能到达同一系统的工具。能放到进程边界外面的工具，用 [MCP 代理](mcp-proxy.md)。要给不是自己实现的工具加闸门，或把未批准的任务交还给框架，用[工具闸门](tool-gate.md)。

## 批准发生在 agent 外面

SDK 不批准任务。批准是 `actledger approve`（以后也可以是 agent 之外的渠道）。agent 的密钥不是批准凭证。

`@actledger/sdk/webhook` 导出了给未来服务端用的 webhook 签名校验。本地引擎不发送 webhook。

状态和回执字段见[状态机](../../spec/zh-CN/state-machine.md)、[回执](../../spec/zh-CN/receipt.md)。
