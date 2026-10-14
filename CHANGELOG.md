# Changelog

## 0.1.0 — unreleased

Not published to npm or PyPI.

### Added

- **Local approval page and webhook channel**

  `actledger serve` runs an approval page on 127.0.0.1 with a one-time login link, and posts signed webhooks configured in `.actledger/channels.yaml`. Webhooks can carry a 15-minute, single-use approve link. The engine now enforces `approval.channels`: `cli`, `web`, and `webhook_link` approvals are accepted only when the task's policy lists that channel, and an empty list means `cli` only. Web and link approvals are `app_asserted`.

- **Tool gate**

  TypeScript `createToolGate` and Python `actledger.gate.ToolGate` split a tool call into `before` and `after`. `ledger.guard` and `@ledger.guard` now run on a wait-mode tool gate. Their behavior is unchanged.

- **Receipt format 0.2**

  Receipts are written as `actledger.receipt/0.2`. Intent text, error messages, and notes are HMAC commitments, and payload hashes are salted per task. `verify` still accepts `actledger.receipt/0.1` and can check a secrets file with `--secrets`. A `step_up` field on an `allow`, `deny`, or `draft_only` rule is rejected when the policy loads. `defaults.approval.step_up` is inherited by `require_approval` rules.

- **MCP proxy**

  `@actledger/mcp-proxy` wraps an upstream MCP server. Each `tools/call` is decided by `policy.yaml`, then recorded as a signed receipt. Tools exposed by the proxy are declared with coverage `enforced` and `via: mcp-proxy`. A pending call can be resumed with the `check_task` tool.

- **Buildable packages**

  The four npm packages build from this repository. GitHub Actions runs typecheck, tests, the Python job, and `pnpm pack:check`. `LICENSE`, `CONTRIBUTING`, `SECURITY`, and `spec/` describe how to build, report issues, and check receipts.

- **Python SDK**

  The `actledger` Python package verifies the same test vectors as TypeScript, opens a local ledger through `actledger rpc`, and includes an optional LangGraph adapter.
