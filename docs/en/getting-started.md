[English](getting-started.md) | [简体中文](../zh-CN/getting-started.md)

# Getting started

ActLedger records agent actions that you choose to integrate. A policy decides whether a call is allowed, held for approval, denied, or kept as a draft. Each transition is appended as a signed receipt that `actledger verify` can check offline.

0.1.0 is not published. These commands run from a clone.

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
```

CLI approval defaults to `app_asserted`. `--assurance channel_verified` or `user_signed` is a local test. The receipt is marked `simulated`, because the CLI does not check a real channel identity.

Put the proxy in front of an MCP server:

```bash
pnpm -s mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

See [mcp-proxy.md](mcp-proxy.md), [sdk-typescript.md](sdk-typescript.md), and [sdk-python.md](sdk-python.md).

## What a receipt is for

A receipt says who started the action, which rule fired, who approved it and at what assurance, which payload was approved, and which payload was executed. The hash chain shows that this record was not edited later. It does not show that every action the agent took was recorded. See [guarantees.md](guarantees.md).

## After publishing

When the packages are on npm:

```bash
npx -y @actledger/cli init
npx -y @actledger/mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

Field-level rules: [the specification](../../spec/README.md). How the pieces fit: [architecture.md](architecture.md).
