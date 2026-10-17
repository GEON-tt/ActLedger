[English](mcp-server.md) | [简体中文](../../zh-CN/scenarios/mcp-server.md)

# An MCP server

## Where this fits

This is the **enforced** path ([guarantees](../guarantees.md)). Start the MCP server through `@actledger/mcp-proxy` and point the client at the proxy. The agent holds no direct connection to that server, so a `tools/call` to an exposed tool cannot run until the ledger claims the task. Exposed tools are declared with coverage `mode: enforced`, `via: mcp-proxy` on the receipt; the overlay is not written into `policy.yaml`. A shell, HTTP client, or browser that can reach the same service still bypasses it. Keep network and credentials isolated yourself. The proxy warns when a tool name contains `shell`, `exec`, `http`, `fetch`, or `browser`.

## Minimal code

Taken from [MCP proxy](../mcp-proxy.md) and [`examples/mcp-proxy-email/proxy.config.yaml`](../../../examples/mcp-proxy-email/proxy.config.yaml).

### From a terminal

```bash
pnpm install
pnpm actledger init
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

### MCP client config

`--ledger` must be an absolute path.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "pnpm",
      "args": [
        "-s", "--dir", "/absolute/path/to/actledger",
        "mcp-proxy",
        "--ledger", "/absolute/path/to/.actledger",
        "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/project"
      ]
    }
  }
}
```

### Map tool names to actions

The example's upstream command is left out here. The mapping is what the ledger sees.

```yaml
version: 1
name: mail
ledger: .actledger
principal: local-user
agent_id: mcp-proxy:mail
approval:
  wait_ms: 3000
tools:
  send_email:
    action: email.send
    content:
      field: body
      content_type: text/plain
  list_inbox:
    action: email.read
```

While a call is waiting for approval, the proxy returns the pending task. The client then calls `check_task` with `{ task_id }`. After approval, that call claims the task and forwards it. [`examples/mcp-proxy-email/run.ts`](../../../examples/mcp-proxy-email/run.ts) does this once a second.

Pass the file with `--config <file>`. The other flags are `--upstream`, `--upstream-cwd`, `--principal`, `--name`, and `--approval-wait`. The flag list and the call sequence are in [MCP proxy](../mcp-proxy.md).

The proxy's default principal is `local-user`. The approval console started without `--approver` approves as the task principal, so there is nothing else to set.

`pnpm exec tsx examples/mcp-proxy-email/run.ts` is a runnable example. It prints an approve command that includes `--assurance channel_verified`, for the reason in Policy below.

## Policy

`actledger init` writes the default policy to `.actledger/policy.yaml` ([source](../../../packages/core/src/default-policy.ts)). The proxy is not a ToolGate. With that file unchanged, an unmapped upstream tool's action type is the upstream tool name itself (for example `read_file`), not `tool.<name>`. A mapped tool uses `tools.<name>.action`. A name that is not listed under `actions` matches no rule, so `defaults.unknown_action: require_approval` applies: the task waits for approval (rule id `default:require_approval`), at assurance `app_asserted`, approvable from `cli` or `web`. Edit that file instead of writing a new one. A policy file is used as a whole; keys you leave out of `defaults` fall back to engine values, and the fallback for `approval.channels` is an empty list, which means CLI only.

Under the default policy, a tool that is not declared waits for approval. The proxy logs `warning: action … is not in policy actions; defaults.unknown_action will apply` for an action that is not in `actions`.

Add a read-only upstream tool under the existing `actions:` key:

```yaml
actions:
  # existing entries stay
  read_file:
    level: read   # the default read-allow rule now allows it
```

`email.read` and `email.send` are already in the default policy. `email.read` matches `read-allow` and is allowed. `email.send` matches `email-external-approve`, which requires `channel_verified` ([evaluate.ts](../../../packages/core/src/policy/evaluate.ts)), so the approval console cannot approve it. `examples/mcp-proxy-email/policy.yaml` lists channels `[cli]` only.

## Next

- [MCP proxy](../mcp-proxy.md)
- [examples/mcp-proxy-email](../../../examples/mcp-proxy-email)
- [Approval console](approval-console.md)
