[English](architecture.md) | [简体中文](../zh-CN/architecture.md)

# Architecture

0.1.0 includes a single-tenant `@actledger/server`: a `/v1` agent API and a password + TOTP approval console. There is no multi-tenant service, PostgreSQL, or external timestamp anchor. Local approval is still `actledger approve`/`reject`, the `actledger serve` page on 127.0.0.1, and signed webhook links. Further hosted work stays behind `Store` on the engine and `Transport` on the SDK.

```mermaid
flowchart LR
  agent["Agent process"]
  sdk["@actledger/sdk or Python Ledger"]
  proxy["@actledger/mcp-proxy"]
  cli["@actledger/cli"]
  core["@actledger/core"]
  db["SQLite ledger.db plus secrets"]
  upstream["Upstream MCP server"]
  remote["RemoteTransport / Python HttpClient"]
  server["@actledger/server"]

  agent --> sdk --> core
  agent --> proxy --> core
  proxy --> upstream
  cli --> core
  core --> db
  remote --> server --> core
```

`@actledger/core` owns canonical JSON, commitments, Ed25519 receipts, the 11-state machine, YAML policy, and the SQLite store. Receipts are append-only. The Python package checks the same vectors and, for local calls, speaks [`actledger rpc`](../../spec/rpc.md) to this engine instead of reimplementing it.

## State machine, in short

`request` enters at `prepared`, then the first matching policy rule moves the task:

- `allow` → `approved` (approver `policy:<rule id>`)
- `require_approval` → `pending_approval`
- `deny` → `rejected`
- `draft_only` → `drafted`

A user approval moves `pending_approval` to `approved`. `claim` is the only way into `executing`, and it works once. `complete` or `fail` leaves `executing`. If the deadline passes first, the state is `unknown`, which must be reconciled rather than retried as if nothing ran. Terminal states are `executed`, `failed`, `rejected`, `drafted`, `expired`, and `revoked`.

The full table is [spec/state-machine.md](../../spec/state-machine.md) and [spec/transitions.json](../../spec/transitions.json).

## Where the check sits

Recorded mode wraps a tool inside the agent. The [MCP proxy](mcp-proxy.md) is enforced mode for the upstream it fronts: it claims the task before it forwards `tools/call`, and it declares `coverage` `enforced` for those tools. Approval still happens outside the agent: the CLI, the `actledger serve` page, or a signed webhook link. See [approval](approval.md).

Policy evaluation is first-match. Unknown actions use `defaults.unknown_action`. Assurance ranks are `policy`, then `app_asserted`, `channel_verified`, and `user_signed`. Details: [spec/policy.md](../../spec/policy.md).

## What verify checks

`actledger verify` recomputes the receipt hash, checks the Ed25519 signature against `keys.json`, walks the chain from the genesis hash, and rebuilds each task's transitions. With a secrets file it recomputes commitments. It does not contact a server. See [guarantees.md](guarantees.md) for what that does not prove.

## Packages

| Package | What it is |
| --- | --- |
| [`@actledger/core`](../../packages/core) | Receipts, payload commitments, the state machine, policy evaluation, verify, and the SQLite ledger |
| [`@actledger/sdk`](../../packages/sdk) | TypeScript `Ledger`: request, wait, claim, complete |
| [`@actledger/cli`](../../packages/cli) | `actledger` for init, approve, export, and verify |
| [`@actledger/server`](../../packages/server) | Single-tenant server: `/v1` agent API, password + TOTP console, `actledger-server` |
| [`@actledger/mcp-proxy`](../../packages/mcp-proxy) | Stdio MCP proxy in front of an upstream server |
| [`@actledger/claude-agent-sdk`](../../packages/claude-agent-sdk) | Claude Agent SDK adapter: `canUseTool` and `PostToolUse` hooks on a ToolGate |
| [`@actledger/openai-agents`](../../packages/openai-agents) | OpenAI Agents SDK adapter: `needsApproval` interruptions and execute recording on a ToolGate |
| [`actledger`](../../python) (Python) | Receipt verifier, local ledger client over `actledger rpc`, optional LangGraph, Claude Agent SDK, and OpenAI Agents SDK adapters |

## Not yet

Multi-tenant hosting, PostgreSQL, Feishu or email channels, a credential gate, RFC 3161 anchoring, and a Java SDK. Later work should go through `Store` and the SDK `Transport`.
