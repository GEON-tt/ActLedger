[English](sdk-typescript.md) | [简体中文](../zh-CN/sdk-typescript.md)

# TypeScript SDK

`@actledger/sdk` is the in-process client. In this repository it uses the local SQLite ledger from `@actledger/core`. There is no HTTP transport yet. A future server should plug in through `Transport`.

From a clone, depend on the workspace package. After publication: `npm install @actledger/sdk`.

## Request, wait, claim, complete

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

`request` writes `prepared` and then the policy decision in the same flow. `wait` polls until the task leaves `pending_approval`. `claim` moves `approved` to `executing` and succeeds once. A second claim is `already_claimed`.

If the process stops after claim, or the execution deadline passes, the task becomes `unknown`. Do not start a new attempt under the same idempotency key while that task is unresolved. Report what happened with `complete` or `fail`, including reconciliation.

`complete` compares the executed payload with the approved payload. Paths listed in `allowed_drift` may differ. In the default `strict` content mode, anything else fails the task with `content_mismatch`. The SDK's `strictContent` option defaults to `true` and checks again before it calls complete.

`intent` is stored as a commitment on a 0.2 receipt. The plaintext stays in the secrets file, not in the receipt.

## Wrapping a tool

`ledger.guard` runs request, wait, claim, and complete around a function. Use it when you own the tool implementation. That is recorded integration: the model can still call a different tool that reaches the same system. For tools you can put behind a process boundary, use the [MCP proxy](mcp-proxy.md). To gate tools you do not own, or to hand a pending task back to your framework, use the [tool gate](tool-gate.md).

## Approval is outside the agent

The SDK does not approve tasks. Approval is `actledger approve` (or, later, a channel that is not the agent). The agent's key is not an approval credential.

Webhook signature checks are exported from `@actledger/sdk/webhook` for a future server. The local engine does not send webhooks.

States and receipt fields: [state machine](../../spec/state-machine.md), [receipts](../../spec/receipt.md).
