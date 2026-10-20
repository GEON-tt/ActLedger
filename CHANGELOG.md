# Changelog

## 0.1.0 — 2026-10-20

Published to npm and PyPI.

### Added

- **Remote server**

  `@actledger/server` and `actledger-server` are a single-tenant server: a `/v1` agent API authenticated with a bearer key that can only submit and execute, a password + TOTP approval console, and a signing key that stays on the server. `new Ledger({ mode: "remote" })` and Python `Ledger(mode="remote")` use `ACTLEDGER_URL` and `ACTLEDGER_API_KEY`. The chat demo can attach to that server. `deploy/` builds a Docker image and a Caddy compose file. `spec/http.md` describes the HTTP API. `guarantees.md` now compares the three deployments, and still calls out the two boundaries that need an external anchor and a credential gate.

- **Scenario docs**

  The README now opens with `pnpm demo`, a mermaid diagram of agent → ToolGate → approval console → receipt, and links to six scenario pages in `docs/en/scenarios/` and `docs/zh-CN/scenarios/`: your own loop, Cursor SDK, Claude Agent SDK, OpenAI Agents SDK, an MCP server behind the proxy, and the approval console. The long reference moved into getting started, MCP proxy, and architecture. `guarantees.md` opens with a recorded-versus-enforced table, and `approval.md` describes the token file, list tabs, timeline, and required rejection reason. `packages/cli/test/docs.test.ts` fails on broken relative links in the README and docs and checks that English and Chinese pages have the same headings and link counts.

- **Chat approval demo**

  `pnpm demo` starts `examples/chat-approval`: a local chat page and the approval console in one process. `list_notes` runs under an allow rule; `send_note` waits inside its tool gate until someone approves it in the console, and only then appends to `out/outbox.jsonl`. After each turn the page shows the task id, approver, receipt hash, and an in-process `verify` result. The default provider is a keyless fake used by `pnpm test`; `ACTLEDGER_DEMO_PROVIDER=cursor|claude|openai` switches to Cursor (grok-4.7), the Claude Agent SDK adapter, or the OpenAI Agents SDK adapter, which are not run in CI. `@actledger/cli` now exports `startServer` from `@actledger/cli/serve`.

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

### Changed

- **Example approvals, accurate approve hints, English package text**

  `examples/claude-agent` and `examples/openai-agents` declare their gated tools as `level: write`, so the approval console and the printed `actledger approve` command both work at the default `app_asserted` assurance; a test runs each printed command and checks the task is approved. `approveHint` in TypeScript and Python (and the LangGraph interrupt hint) now add `--assurance <min>` when the task needs more than `app_asserted`, `--step-up` when it needs a step-up, and `--note "<reason>"` to the reject command; `approveCommandLine` / `approve_command_line` return the approve command alone. MCP proxy tool results and the `check_task` description, `actledger show` and `export --secrets` output, the schema-1 open error, the `v01_plaintext` warning (now `0.1 receipts contain plaintext intent, error message, note or reason` in both TypeScript and Python; the code is unchanged), and JSDoc in published packages are in English. The console's English strings no longer embed Chinese; that text stays in the zh-CN dictionary. `CODE_OF_CONDUCT.md` names the maintainer email as the enforcement contact.
