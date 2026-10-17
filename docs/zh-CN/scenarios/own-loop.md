[English](../../en/scenarios/own-loop.md) | [简体中文](own-loop.md)

# 你自己的 agent 循环

## 放在哪里

ToolGate 是**记录式**接入（[保证边界](../guarantees.md)）。它跑在你的进程里，位于循环决定调用工具和工具真正运行之间。走过 `before`/`after` 的调用按状态机进行，可以批准，并留下回执，但没有任何东西阻止模型或你的代码用别的方式访问同一个服务。当你自己持有循环，或框架没有适配器时，用它。

## 最小代码

取自 [`examples/chat-approval/tools.ts`](../../../examples/chat-approval/tools.ts)。`callTool` 是 fake 提供方和 Cursor 提供方共用的路径。

```ts
import { createToolGate, Ledger } from "@actledger/sdk";

const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const gate = createToolGate({
  ledger,
  principal: "u_1",
  agentId: "chat-approval",
  mode: "wait",
  timeoutMs: 15 * 60_000,
  pollMs: 250,
});

// runTool is your tool implementation. It receives the approved args.
declare function runTool(name: string, args: unknown): Promise<string>;

export async function callTool(name: string, args: Record<string, unknown>) {
  let decision;
  try {
    decision = await gate.before(name, args);
  } catch {
    return { ok: false, output: `${name} was not performed: ledger error`, taskId: null };
  }
  if (decision.kind === "deny") {
    return {
      ok: false,
      taskId: decision.taskId,
      output: `${name} was not performed: ${decision.reason} (task ${decision.taskId}). ${decision.message}`,
    };
  }
  if (decision.kind === "pending") {
    return {
      ok: false,
      taskId: decision.taskId,
      output: `${name} was not performed: pending (task ${decision.taskId}). ${decision.approveHint}`,
    };
  }
  if (decision.run === null) {
    return { ok: false, output: `${name} was not performed: ledger unavailable`, taskId: null };
  }
  const run = decision.run;
  let output: string;
  try {
    output = await runTool(name, decision.approvedPayload.args);
  } catch (error) {
    await gate.after(run, { error, code: "tool_error" });
    return { ok: false, output: `${name} failed: ${error instanceof Error ? error.message : String(error)}`, taskId: run.taskId };
  }
  await gate.after(run, { result: output });
  return { ok: true, output, taskId: run.taskId };
}
```

源码里的 `runTool` 是 `sendNoteRaw` 或 `listNotesRaw`，闸门还传入了 `map: noteMapping`，返回的提示里多一句 "Tell the user it was not done."。

wait 模式下，`before` 会阻塞到有决定，或 `timeoutMs` 到期。到期返回 `deny`，reason 是 `timeout`，任务仍是 `pending_approval`。`pending` 只在 defer 模式，或任务仍在等待时的 `resume` 里出现。示例保留这个分支，是为了换成 defer 时不会漏掉。

执行时用 `decision.approvedPayload.args`。审批人可能已经用 CLI 的 `--edit` 改过参数。

工具抛错时一定调用 `after(run, { error })`。否则任务停在 `executing`，之后变成 `unknown`。

### 意图和载荷

下面的 `map` 就是 demo 的 `noteMapping`：

```ts
map: (name, input) => {
  const type = `tool.${name}`;
  if (name === "send_note") {
    const args = { text: typeof input.text === "string" ? input.text : "" };
    return { action: { type }, payload: { action: type, args }, intent: `send note: ${args.text.slice(0, 80)}` };
  }
  return { action: { type }, payload: { action: type, args: input } };
},
```

intent 会显示在审批台列表和任务页上。回执里只存承诺。

完整 API、defer 模式和 `resume`，以及 Python 版闸门，见[工具闸门](../tool-gate.md)。

## 策略

`actledger init` 会把默认策略写到 `.actledger/policy.yaml`（[源码](../../../packages/core/src/default-policy.ts)）。不改这个文件时，经过闸门的工具调用是 `tool.<name>`，它不在 `actions` 里，没有规则匹配，于是走 `defaults.unknown_action: require_approval`：任务等待批准（rule id `default:require_approval`），保证等级 `app_asserted`，可以从 `cli` 或 `web` 批。请在这个文件上改，不要另写一份。策略文件整份生效；`defaults` 里省略的键回落到引擎值，其中 `approval.channels` 的回落值是空列表，也就是只有 CLI。

把只读工具和写入工具加在文件里已有的 `actions:` 键下面。效果和 demo 一样：`list_notes` 放行，`send_note` 等待批准。

```yaml
actions:
  # existing entries stay
  tool.list_notes:
    level: read   # the default read-allow rule now allows it
  tool.send_note:
    level: write  # no rule matches, so it still waits for approval
```

`level` 设成 `send`、`spend` 或 `delete` 会把最低保证抬到 `channel_verified`（[evaluate.ts](../../../packages/core/src/policy/evaluate.ts)）。审批台无法批准。见[审批台](approval-console.md)。如果确实要高风险级别，又要在审批台批准，就在该动作的规则上写 `approval: { min_assurance: app_asserted }`。这是有意降低门槛，要在规则里写清楚。高风险级别没有 coverage glob 时，加载会告警 `uncovered_high_risk`。

```yaml
coverage:
  # existing entries stay
  - action: tool.*
    mode: recorded
    via: my-agent
```

coverage 只是写在回执上的声明。没有 glob 匹配时，`integrationMode` 仍然记为 `recorded`。

demo 自带一份完整的 `policy.yaml`，其中 `allow_edit: false`，因为每次启动都会覆盖它自己账本里的策略。你自己的项目不需要整份重写。

## 下一步

- [工具闸门](../tool-gate.md)
- [examples/chat-approval](../../../examples/chat-approval/README.zh-CN.md)。`pnpm demo` 走的就是这条路径。
- [审批台](approval-console.md)
