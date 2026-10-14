from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from actledger import Ledger
from actledger.gate import ToolGate

pytestmark = [pytest.mark.claude, pytest.mark.node, pytest.mark.anthropic_api]


def _init_echo(cli, directory: Path) -> None:
    policy = directory.parent / "echo-policy.yaml"
    policy.write_text(
        """
version: 1
defaults:
  unknown_action: require_approval
  content_mode: strict
  approval:
    channels: [cli]
    timeout: 15m
    allow_edit: true
    min_assurance: app_asserted
actions:
  tool.mcp__ledger__echo: { level: read }
rules:
  - id: echo-allow
    match: { action: tool.mcp__ledger__echo }
    effect: allow
""".lstrip(),
        encoding="utf-8",
    )
    result = cli(["init", "--dir", str(directory), "--policy", str(policy)])
    assert result.returncode == 0, result.stderr or result.stdout


def test_real_model_records_sdk_mcp_tool(tmp_path: Path, cli) -> None:
    from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool

    from actledger.claude_agent import claude_agent_adapter

    directory = tmp_path / "ledger"
    _init_echo(cli, directory)

    @tool("echo", "Echo text", {"text": str})
    async def echo(args):
        return {"content": [{"type": "text", "text": args["text"]}]}

    server = create_sdk_mcp_server(name="ledger", tools=[echo])

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = claude_agent_adapter(gate)
            options = adapter.options(
                ClaudeAgentOptions(mcp_servers={"ledger": server}, max_turns=3),
            )
            async for _message in query(
                prompt="Call the mcp__ledger__echo tool with text 'hi', then stop.",
                options=options,
            ):
                pass
            listed = cli(["tasks", "--dir", str(directory), "--json"])
            assert listed.returncode == 0, listed.stderr or listed.stdout
            tasks = json.loads(listed.stdout)
            assert any(
                item.get("action", {}).get("type") == "tool.mcp__ledger__echo" and item.get("state") == "executed"
                for item in tasks
            )

    asyncio.run(main())
