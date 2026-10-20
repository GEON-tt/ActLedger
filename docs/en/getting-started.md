[English](getting-started.md) | [简体中文](../zh-CN/getting-started.md)

# Getting started

ActLedger records agent actions that you choose to integrate. A policy decides whether a call is allowed, held for approval, denied, or kept as a draft. Each transition is appended as a signed receipt that `actledger verify` can check offline.

0.1.0 is on npm and PyPI.

## Install

```bash
npm i -g @actledger/cli
pip install actledger
```

The npm package is the CLI. The PyPI package is the Python SDK. Local mode starts `actledger rpc`, so the CLI has to be on `PATH`.

## Requirements

- Node.js 22.13 or newer
- pnpm 9 (`packageManager` in the root `package.json`)
- Optional: Python 3.10 or newer, for the Python package

## Run from source

```bash
git clone https://github.com/GEON-tt/ActLedger.git
cd ActLedger
corepack enable
pnpm install
pnpm actledger init
```

`init` creates `.actledger/` with an Ed25519 key, a data key, `ledger.db`, and `policy.yaml`. That directory holds secrets. Do not commit it.

List, approve, export, and verify:

```bash
pnpm actledger tasks
pnpm actledger approve tsk_...
pnpm -s actledger export > receipts.jsonl
pnpm actledger verify receipts.jsonl --keys .actledger/keys.json
pnpm actledger show rcp_...
```

CLI approval defaults to `app_asserted`. `--assurance channel_verified` or `user_signed` is a local test. The receipt is marked `simulated`, because the CLI does not check a real channel identity.

Put the proxy in front of an MCP server:

```bash
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

See [mcp-proxy.md](mcp-proxy.md), [sdk-typescript.md](sdk-typescript.md), and [sdk-python.md](sdk-python.md).

## Examples

`pnpm demo` starts the chat and the approval console. The default model is the built-in fake model, so no API key is needed. See [examples/chat-approval](../../examples/chat-approval).

The email example waits for approval:

```bash
pnpm actledger init --policy examples/local-email-agent/policy.yaml
# another terminal
pnpm exec tsx examples/local-email-agent/run.ts
pnpm actledger approve tsk_... --assurance channel_verified
```

Run the MCP proxy email example:

```bash
pnpm exec tsx examples/mcp-proxy-email/run.ts
```

The webhook receiver for `actledger serve` needs no API key. Steps are in [examples/webhook-receiver](../../examples/webhook-receiver):

```bash
ACTLEDGER_WEBHOOK_SECRET=dev-secret pnpm exec tsx examples/webhook-receiver/run.ts
```

Adapter examples: `examples/claude-agent` needs `ANTHROPIC_API_KEY`, and `examples/openai-agents` needs `OPENAI_API_KEY`. Without the key they print a skip message and exit 0. The keyless tests are `packages/claude-agent-sdk/test/adapter.test.ts` and `packages/openai-agents/test/adapter.test.ts`.

`examples/*/run-agent.ts` calls the Cursor SDK. Copy the repository root `.env.example` to `.env` and set `CURSOR_API_KEY` before running those scripts. Do not commit `.env`.

Step-by-step pages by scenario: [scenarios](scenarios/own-loop.md).

## What a receipt is for

A receipt says who started the action, which rule fired, who approved it and at what assurance, which payload was approved, and which payload was executed. The hash chain shows that this record was not edited later. It does not show that every action the agent took was recorded. See [guarantees.md](guarantees.md).

## After publishing

Without a global install:

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

Python: `pip install actledger`.

Field-level rules: [the specification](../../spec/README.md). How the pieces fit: [architecture.md](architecture.md).
