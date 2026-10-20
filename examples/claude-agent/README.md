[English](README.md) | [简体中文](README.zh-CN.md)

# Claude Agent SDK

Documentation plus an optional run against a real model. Without `ANTHROPIC_API_KEY` the script prints a skip line and exits 0.

Keyless proof:

```bash
pnpm exec vitest run packages/claude-agent-sdk/test/adapter.test.ts
```

Python, after `pip install -e "./python[test,claude]"`:

```bash
python/.venv/bin/python -m pytest python/tests/test_claude_agent.py -q
```

Run from the repository root. In another terminal, approve with the command the script prints, or on the approval console (`pnpm actledger serve --dir <ledger dir>`). `policy.yaml` declares `send_note` as `level: write`, so both work at the default `app_asserted` assurance.

```bash
ANTHROPIC_API_KEY=… pnpm exec tsx examples/claude-agent/run.ts
```

`send_note` makes `canUseTool` block until you approve or the 5 minute gate timeout fires. On timeout the adapter denies the tool. The task stays `pending_approval`.

This adapter runs in the agent process. It is recorded. Do not put these tools in `allowedTools`, or Claude skips `canUseTool`. See [Claude Agent SDK](../../docs/en/integrations.md#claude-agent-sdk).

The Python wiring is the Python block in that same page. This example does not ship a `.py` script.
