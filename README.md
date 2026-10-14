[English](README.md) | [简体中文](README.zh-CN.md)

# ActLedger

One command adds approval and verifiable receipts in front of any MCP server.

0.1.0 is not published yet. The commands below run from a clone.

```bash
git clone https://github.com/GEON-tt/ActLedger.git
cd ActLedger
corepack enable
pnpm install
pnpm actledger init
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

`pnpm actledger init` writes an Ed25519 signing key, a data key, `ledger.db`, and `policy.yaml` under `.actledger/`. `pnpm mcp-proxy` wraps the upstream MCP server. Each `tools/call` is allowed, held for approval, or denied according to `policy.yaml`, and the result is appended as a signed receipt.

A tool that is not listed under `actions` follows `defaults.unknown_action` (default `require_approval`). If a tool name contains shell, exec, http, fetch, or browser, the proxy warns that the tool can bypass the proxy.

Approve and verify from the same clone:

```bash
pnpm actledger tasks --dir .actledger
pnpm actledger approve tsk_... --dir .actledger
pnpm -s actledger export --dir .actledger > receipts.jsonl
pnpm actledger verify receipts.jsonl --keys .actledger/keys.json
```

Point an MCP client at this checkout. `--ledger` must be an absolute path:

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

## Package map

| Package | What it is |
| --- | --- |
| [`@actledger/core`](packages/core) | Receipts, payload commitments, the state machine, policy evaluation, verify, and the SQLite ledger |
| [`@actledger/sdk`](packages/sdk) | TypeScript `Ledger`: request, wait, claim, complete |
| [`@actledger/cli`](packages/cli) | `actledger` for init, approve, export, and verify |
| [`@actledger/mcp-proxy`](packages/mcp-proxy) | Stdio MCP proxy in front of an upstream server |
| [`actledger`](python) (Python) | Receipt verifier, local ledger client over `actledger rpc`, optional LangGraph adapter |

Normative field rules are in [spec/README.md](spec/README.md). A short architecture note is in [docs/en/architecture.md](docs/en/architecture.md).

## Guarantee boundary

Actions that are not integrated are outside the guarantee. Integrated actions have two strengths. See [docs/en/guarantees.md](docs/en/guarantees.md).

- **Recorded.** The SDK wraps the tool. The ledger can approve and verify those calls. It cannot stop the model from using a shell, a generic HTTP client, or a browser to go around the wrapper.
- **Enforced.** A proxy or a credential gate sits outside the agent process. The MCP proxy is implemented and is enforced. A credential gate is not implemented.

The hash chain shows that recorded receipts were not altered. It does not show that every action was recorded.

Frameworks without an adapter can use the tool gate: call `before` ahead of a tool call and `after` when it returns. It is recorded integration; the MCP proxy stays the enforced path. See [docs/en/tool-gate.md](docs/en/tool-gate.md).

## TypeScript SDK

From this repository the SDK resolves through the workspace. After publication, `npm install @actledger/sdk`.

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

`claim` moves `approved` to `executing` and can succeed only once. If the process dies after claim, the task becomes `unknown`. It is not treated as "not executed" and retried. More detail: [docs/en/sdk-typescript.md](docs/en/sdk-typescript.md).

## Python

Python 3.10 or newer. Use the stdlib `venv` and `pip`.

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
python/.venv/bin/python -m actledger verify receipts.jsonl --keys .actledger/keys.json
```

`Ledger(mode="local", dir=...)` does not reimplement the engine. It starts the TypeScript CLI `actledger rpc` and speaks one JSON object per line. Approve and reject still run in another process as `actledger approve` / `actledger reject`. In a clone, install Node dependencies with `pnpm install` first so the client can find `tsx`. More detail: [docs/en/sdk-python.md](docs/en/sdk-python.md).

## Requirements

Node.js 22.13 or newer, and pnpm 9. This repo pins the package manager in `package.json`.

## Local development

`init` writes keys and the default policy under `.actledger/`. CLI approval defaults to `app_asserted`. `--assurance channel_verified` or `user_signed` is for local testing. The receipt is marked `simulated`, because the CLI does not perform a real channel identity check.

```bash
pnpm actledger tasks
pnpm actledger approve tsk_... --assurance channel_verified
pnpm -s actledger export > receipts.jsonl
pnpm actledger verify receipts.jsonl --keys .actledger/keys.json
pnpm actledger show rcp_...
```

The email example waits for approval:

```bash
pnpm actledger init --policy examples/local-email-agent/policy.yaml
# another terminal
pnpm exec tsx examples/local-email-agent/run.ts
pnpm actledger approve tsk_... --assurance channel_verified
```

MCP proxy email example:

```bash
pnpm exec tsx examples/mcp-proxy-email/run.ts
```

`examples/*/run-agent.ts` calls the Cursor SDK. Copy `.env.example` to `.env` and set `CURSOR_API_KEY` before running those scripts. Do not commit `.env`.

## Specification

Protocol format: [spec/README.md](spec/README.md). Chinese prose: [spec/zh-CN/README.md](spec/zh-CN/README.md). JSON Schema and `spec/test-vectors/` are shared.

## Tests and build

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
python/.venv/bin/pytest python -q
```

`pnpm test` runs the TypeScript source and does not need a build first. `pnpm pack:check` packs the npm tarballs and installs them from the network. Run it on its own.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Guides: [getting started](docs/en/getting-started.md), [MCP proxy](docs/en/mcp-proxy.md), [TypeScript SDK](docs/en/sdk-typescript.md), [Python SDK](docs/en/sdk-python.md), [tool gate](docs/en/tool-gate.md), [guarantees](docs/en/guarantees.md), [architecture](docs/en/architecture.md).

## Community plugins

No community plugins are listed yet. Open a pull request to add one.

## Not yet

HTTP service, PostgreSQL, a hosted approval page, Feishu or email channels, a credential gate, RFC 3161 anchoring, and a Java SDK. Later work should go through `Store` and the SDK `Transport`.

## After publishing

When 0.1.0 is on npm, the same flow can start without a clone:

```bash
npx -y @actledger/cli init
npx -y @actledger/mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

```bash
npx @actledger/cli tasks --dir .actledger
npx @actledger/cli approve tsk_... --dir .actledger
npx @actledger/cli export --dir .actledger > receipts.jsonl
npx @actledger/cli verify receipts.jsonl --keys .actledger/keys.json
```

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "@actledger/mcp-proxy",
        "--ledger", "/absolute/path/to/.actledger",
        "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/project"
      ]
    }
  }
}
```

Python, after a PyPI release: `pip install actledger`. This repository is not uploaded yet.

## License

Apache-2.0. See [LICENSE](LICENSE).
