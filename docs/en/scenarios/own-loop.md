[English](own-loop.md) | [简体中文](../../zh-CN/scenarios/own-loop.md)

# Your own agent loop

## Where this fits

ToolGate is **recorded** integration ([guarantees](../guarantees.md)). It runs inside your process, between your loop deciding to call a tool and the tool running. Calls that go through `before`/`after` follow the state machine, can be approved, and leave receipts, but nothing stops the model or your code from reaching the same service another way. Use it when you own the loop or the framework has no adapter.

## Minimal code

Taken from [`examples/chat-approval/tools.ts`](../../../examples/chat-approval/tools.ts). `callTool` is the path the fake provider and the Cursor provider share.

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

In the source, `runTool` is `sendNoteRaw` or `listNotesRaw`, the gate also takes `map: noteMapping`, and the returned text adds "Tell the user it was not done."

In wait mode, `before` blocks until there is a decision or `timeoutMs` expires. Expiry returns `deny` with reason `timeout`, and the task stays `pending_approval`. `pending` is returned only in defer mode, or by `resume` while the task is still waiting. The example keeps that branch so a switch to defer still handles it.

Run the tool with `decision.approvedPayload.args`. The approver may have changed the args with the CLI `--edit` flag.

If the tool throws, call `after(run, { error })`. Otherwise the task stays in `executing` and later becomes `unknown`.

### Intent and payload

This `map` is the demo's `noteMapping`:

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

The intent is shown on the approval console list and on the task page. The receipt stores only the commitment.

The full API, defer mode plus `resume`, and the Python gate are in the [tool gate](../tool-gate.md) guide.

## Policy

`actledger init` writes the default policy to `.actledger/policy.yaml` ([source](../../../packages/core/src/default-policy.ts)). With that file unchanged, a gated tool call is `tool.<name>`, which is not listed under `actions`, so no rule matches and `defaults.unknown_action: require_approval` applies: the task waits for approval (rule id `default:require_approval`), at assurance `app_asserted`, approvable from `cli` or `web`. Edit that file instead of writing a new one. A policy file is used as a whole; keys you leave out of `defaults` fall back to engine values, and the fallback for `approval.channels` is an empty list, which means CLI only.

Add the read and write tools under the file's existing `actions:` key. The effect matches the demo: `list_notes` is allowed and `send_note` waits for approval.

```yaml
actions:
  # existing entries stay
  tool.list_notes:
    level: read   # the default read-allow rule now allows it
  tool.send_note:
    level: write  # no rule matches, so it still waits for approval
```

A `level` of `send`, `spend`, or `delete` raises the minimum assurance to `channel_verified` ([evaluate.ts](../../../packages/core/src/policy/evaluate.ts)). The approval console cannot approve that task. See the [approval console](approval-console.md). To keep a high-risk level and still approve it there, write `approval: { min_assurance: app_asserted }` on that action's rule. That lowers the bar on purpose, so say so in the rule. A high-risk level with no coverage glob warns `uncovered_high_risk` when the policy loads.

```yaml
coverage:
  # existing entries stay
  - action: tool.*
    mode: recorded
    via: my-agent
```

Coverage is a declaration written on the receipt. When no glob matches, `integrationMode` is still recorded.

The demo ships a complete `policy.yaml` with `allow_edit: false`, because each start overwrites the policy in its own ledger. Your project does not need to rewrite the whole file.

## Next

- [Tool gate](../tool-gate.md)
- [examples/chat-approval](../../../examples/chat-approval/README.md). `pnpm demo` is this path.
- [Approval console](approval-console.md)
