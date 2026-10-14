[English](mcp-proxy.md) | [简体中文](../zh-CN/mcp-proxy.md)

# MCP proxy

`@actledger/mcp-proxy` is a stdio MCP server that sits in front of another MCP server. The agent talks only to the proxy. Before a `tools/call` is forwarded, the proxy asks the local ledger. The call is allowed, held for approval, or denied. The transition is written as a signed receipt.

This is enforced integration for the tools the proxy exposes: the agent does not hold a direct connection to that upstream. A shell, generic HTTP client, or browser that can reach the same service still bypasses the proxy. The proxy warns when a tool name contains `shell`, `exec`, `http`, `fetch`, or `browser`.

## From a clone

```bash
pnpm install
pnpm actledger init
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

`--ledger` should be an absolute path in an MCP client config. After publication the same binary is `npx -y @actledger/mcp-proxy`.

The proxy also accepts `--upstream "<cmd>"`, `--config <file>`, `--principal`, `--name`, and `--approval-wait`. `--upstream` is split without a shell.

## What happens on a call

1. Tool arguments become `payload.args`. A configured content field can move into `payload.content`.
2. The policy picks `allow`, `require_approval`, `deny`, or `draft_only`. A tool with no `actions` entry uses `defaults.unknown_action` (`require_approval` unless you change it).
3. On `allow`, the proxy claims the task (`approved` → `executing`) and forwards the call.
4. On `require_approval`, the proxy returns the pending task. The default follow-up tool is `check_task`. After someone runs `actledger approve`, a later `check_task` claims and forwards.
5. Exposed tools are overlaid as coverage `mode: enforced`, `via: mcp-proxy`. The overlay is not written back into `policy.yaml`.

Approve from another terminal:

```bash
pnpm actledger tasks --state pending_approval
pnpm actledger approve tsk_...
```

## Config sketch

```yaml
version: 1
name: mail
ledger: .actledger
principal: local-user
agent_id: mcp-proxy:mail
upstream:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
approval:
  wait_ms: 8000
tools:
  send_email:
    action: email.send
    content:
      field: body
      content_type: text/plain
```

`tools` maps an upstream tool name to an ActLedger `action`. Unlisted upstream tools still pass through the unknown-action default.

A worked example lives in `examples/mcp-proxy-email/`. Run it with `pnpm exec tsx examples/mcp-proxy-email/run.ts`.

Normative payload and policy rules are in [the specification](../../spec/payload.md) and [policy.md](../../spec/policy.md). The proxy mapping itself is informative: a verifier does not depend on it.
