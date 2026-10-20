[English](README.md) | [简体中文](README.zh-CN.md)

# OpenAI Agents SDK

Documentation plus an optional run against a real model. Without `OPENAI_API_KEY` the script prints a skip line and exits 0.

Keyless proof:

```bash
pnpm exec vitest run packages/openai-agents/test/adapter.test.ts
```

Python, after `pip install -e "./python[test,openai-agents]"`:

```bash
python/.venv/bin/python -m pytest python/tests/test_openai_agents.py -q
```

Run from the repository root. When the script prints an approve hint, approve in another terminal with `actledger approve` or `actledger serve`. `policy.yaml` declares `send_email` as `level: write`, so both work at the default `app_asserted` assurance. The wait gives up after 5 minutes, prints `still pending, giving up`, and exits 0. The task stays `pending_approval`.

```bash
OPENAI_API_KEY=… pnpm exec tsx examples/openai-agents/run.ts
```

`state.approve` is the SDK call that lets the run continue. It is not a ledger approval. The ledger approval happens in the other terminal.

Unwrapped tools and tools from `mcpServers` never reach the ledger. This is recorded. To enforce MCP tools, run them through the MCP proxy. See [OpenAI Agents SDK](../../docs/en/integrations.md#openai-agents-sdk).

The Python wiring is the Python block in that same page. This example does not ship a `.py` script.
