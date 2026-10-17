# Changelog

## 0.1.0 — unreleased

Not published to npm or PyPI.

### Added

- **Re-enterable approval console**

  `actledger serve` keeps its login token in `.actledger/serve.token` (mode 0600), so the same login URL works across restarts and repeated logins. `--print-login` prints the URL and exits, `--rotate-token` invalidates old URLs and sessions, and `--one-time-login` keeps the previous one-time token. Posts without an `Origin` header (Safari) are accepted only with `Sec-Fetch-Site: same-origin`/`none` or an allowed `Referer`, plus the CSRF token and session cookie. The page now has pending / recent / all tabs that refresh every 3 seconds from `GET /api/tasks`, a task timeline built from receipts, and requires a reason to reject; `actledger reject` requires `--note`.

- **Integration guide and examples**

  `docs/en/integrations.md` and `docs/zh-CN/integrations.md` compare the tool gate, the Claude Agent SDK adapter, the OpenAI Agents SDK adapter, and the MCP proxy, and say which are recorded and which is enforced. `examples/webhook-receiver` verifies `actledger serve` webhooks with `verifyWebhook` and prints the signed approve link, with no API key. `examples/claude-agent` and `examples/openai-agents` show the adapter wiring against a real model; without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` they exit with a skip message and are not part of `pnpm test`.

- **OpenAI Agents SDK adapter**

  `@actledger/openai-agents` and `actledger.openai_agents` (extra `actledger[openai-agents]`) mount a defer-mode tool gate on the OpenAI Agents SDK. `needsApproval` asks the ledger; a pending task becomes a native interruption. `resolveInterruptions` reads the ledger and calls the SDK's `state.approve` or `state.reject`, so the run continues or the model gets the deny reason. The execute wrapper claims the task right before the tool runs and completes or fails it. Approval still happens out of process. This is recorded integration: unwrapped tools and MCP server tools never reach the ledger.

- **Claude Agent SDK adapter**

  `@actledger/claude-agent-sdk` and `actledger.claude_agent` (extra `actledger[claude]`) mount a wait-mode tool gate on the Claude Agent SDK. `canUseTool` asks the ledger and returns allow with the approved input, or deny with the task id and reason. `PostToolUse` completes the task and `PostToolUseFailure` fails it. This is recorded integration: tools that the SDK auto-allows never reach `canUseTool`.

- **Local approval page and webhook channel**

  `actledger serve` runs an approval page on 127.0.0.1 with a one-time login link, and posts signed webhooks configured in `.actledger/channels.yaml`. Webhooks can carry a 15-minute, single-use approve link. The engine now enforces `approval.channels`: `cli`, `web`, and `webhook_link` approvals are accepted only when the task's policy lists that channel, and an empty list means `cli` only. Web and link approvals are `app_asserted`.

- **Tool gate**

  TypeScript `createToolGate` and Python `actledger.gate.ToolGate` split a tool call into `before` and `after`. `ledger.guard` and `@ledger.guard` now run on a wait-mode tool gate. Their behavior is unchanged.

- **Receipt format 0.2**

  Receipts are written as `actledger.receipt/0.2`. Intent text, error messages, and notes are HMAC commitments, and payload hashes are salted per task. `verify` still accepts `actledger.receipt/0.1` and can check a secrets file with `--secrets`. A `step_up` field on an `allow`, `deny`, or `draft_only` rule is rejected when the policy loads. `defaults.approval.step_up` is inherited by `require_approval` rules.

- **MCP proxy**

  `@actledger/mcp-proxy` wraps an upstream MCP server. Each `tools/call` is decided by `policy.yaml`, then recorded as a signed receipt. Tools exposed by the proxy are declared with coverage `enforced` and `via: mcp-proxy`. A pending call can be resumed with the `check_task` tool.

- **Buildable packages**

  The six npm packages build from this repository. GitHub Actions runs typecheck, tests, the Python job, and `pnpm pack:check`. `LICENSE`, `CONTRIBUTING`, `SECURITY`, and `spec/` describe how to build, report issues, and check receipts.

- **Python SDK**

  The `actledger` Python package verifies the same test vectors as TypeScript, opens a local ledger through `actledger rpc`, and includes an optional LangGraph adapter.
