# Chat approval demo

One command starts a local chat page and the ActLedger approval console in the same process. `send_note` waits inside its tool gate until a person approves it in the console, and only then appends a line to `out/outbox.jsonl`. After each turn the page shows the task id, approver, receipt hash, and an in-process verify result.

## Run

From the repository root:

```bash
pnpm install
pnpm demo
```

The terminal prints both URLs and the login link, then opens a browser. `ACTLEDGER_DEMO_NO_OPEN=1` skips the browser. The approval console defaults to port 4328 and the chat page to port 4340. Change them with `ACTLEDGER_DEMO_SERVE_PORT` and `ACTLEDGER_DEMO_CHAT_PORT`.

Data lives in `examples/chat-approval/out/` (gitignored). `ACTLEDGER_DEMO_FRESH=1` deletes that directory and starts over. The login link stays valid across restarts (`out/ledger/serve.token`).

## Environment

| Variable | Purpose |
| --- | --- |
| `ACTLEDGER_DEMO_PROVIDER` | `fake` (default), `cursor`, `claude`, or `openai` |
| `CURSOR_API_KEY` | Required for the Cursor provider |
| `ANTHROPIC_API_KEY` | Claude provider |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude provider |
| `ACTLEDGER_DEMO_CLAUDE_LOGIN` | Set to `1` when Claude Code is already logged in on this machine |
| `OPENAI_API_KEY` | Required for the OpenAI provider |
| `OPENAI_DEFAULT_MODEL` | Optional OpenAI model id |
| `ACTLEDGER_DEMO_SERVE_PORT` | Approval console port (default 4328) |
| `ACTLEDGER_DEMO_CHAT_PORT` | Chat port (default 4340) |
| `ACTLEDGER_DEMO_NO_OPEN` | Set to `1` to not open a browser |
| `ACTLEDGER_DEMO_FRESH` | Set to `1` to clear `out/` before start |

Keys are read only from the environment. They can also live in `examples/chat-approval/.env` (gitignored, do not commit). The demo does not print or save keys.

## Connect to a remote server

Set both `ACTLEDGER_URL` and `ACTLEDGER_API_KEY`. The demo then does not create `out/ledger` and does not start a local `actledger serve`. The outbox stays in `out/outbox.jsonl` on the agent machine. The terminal prints the remote console URL and opens only the chat page.

On the server, initialize with `examples/chat-approval/policy.yaml`, create the approver with `--principal u_1`, and create the key with `agent-key create --agent chat-approval --principal u_1`. The rule for `tool.send_note` is `level: write` and `min_assurance: app_asserted`, so the console can approve it. Setting only one of the two variables is an error that names the missing one.

## Where the gate sits

All four providers are recorded integrations.

- **fake** and **cursor** call `createToolGate` inside the tool function. That gate is wait mode, with a 15 minute timeout, polling every 250 ms.
- **claude** calls the gate from the adapter's `canUseTool` (wait mode). The tool function uses the raw note writer so it does not open a second task.
- **openai** calls the gate from the adapter's `needsApproval`. The OpenAI adapter only accepts defer mode, so this provider polls `resolveInterruptions` every 1 s for up to 15 minutes.

## Manual checks

### Cursor

1. Set `CURSOR_API_KEY` and `ACTLEDGER_DEMO_PROVIDER=cursor`, then run `pnpm demo`.
2. Send「列出笔记」. There is no waiting-for-approval row. The summary approver is `policy:list-notes-allow`, and verify is OK.
3. Send「帮我发一条笔记：明天下午三点开会」. A waiting row and a task link appear. The tool row says `send_note`, not `mcp`.
4. Open the link and approve in the console. The chat continues, `out/outbox.jsonl` gains a line, and the summary shows approver `u_1 via web`, a receipt hash, and verify OK.
5. Send another note and reject it in the console with a reason. The reply says it was not sent, the outbox is unchanged, and the summary shows rejected plus「已记录拒绝理由」.

### Claude

1. Set `ACTLEDGER_DEMO_PROVIDER=claude` and one of `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ACTLEDGER_DEMO_CLAUDE_LOGIN=1`, then run `pnpm demo`.
2. Send「列出笔记」. There is no waiting-for-approval row. The summary approver is `policy:list-notes-allow`, and verify is OK.
3. Send「帮我发一条笔记：明天下午三点开会」. A waiting row and a task link appear. The tool row says `send_note`, not `mcp`.
4. Open the link and approve in the console. The chat continues, `out/outbox.jsonl` gains a line, and the summary shows approver `u_1 via web`, a receipt hash, and verify OK.
5. Send another note and reject it in the console with a reason. The reply says it was not sent, the outbox is unchanged, and the summary shows rejected plus「已记录拒绝理由」.

### OpenAI

1. Set `OPENAI_API_KEY` and `ACTLEDGER_DEMO_PROVIDER=openai` (`OPENAI_DEFAULT_MODEL` is optional), then run `pnpm demo`.
2. Send「列出笔记」. There is no waiting-for-approval row. The summary approver is `policy:list-notes-allow`, and verify is OK.
3. Send「帮我发一条笔记：明天下午三点开会」. A waiting row and a task link appear. The tool row says `send_note`, not `mcp`.
4. Open the link and approve in the console. The chat continues, `out/outbox.jsonl` gains a line, and the summary shows approver `u_1 via web`, a receipt hash, and verify OK.
5. Send another note and reject it in the console with a reason. The reply says it was not sent, the outbox is unchanged, and the summary shows rejected plus「已记录拒绝理由」.

## CI

`pnpm test` runs only the fake provider. Cursor, Claude, and OpenAI are not called in CI. They are typechecked.

## Security

This is a local demo, not an authenticated product. The chat server has no login, so any program on the same machine can use it. It listens only on 127.0.0.1 and rejects a request whose Host is not `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. It accepts only JSON POST bodies and does not forward requests. A request with no Origin header is allowed: the Host check plus the JSON content type stops a cross-site form post, because that post cannot send JSON without a CORS preflight, and this server sends no CORS headers.

The approval console keeps the login, CSRF, and Origin rules from `actledger serve`. The chat page does not show the approval console's login token.

## Claude

There is no offline way to tell whether Claude Code is already logged in. Set `ACTLEDGER_DEMO_CLAUDE_LOGIN=1` to say that it is.
