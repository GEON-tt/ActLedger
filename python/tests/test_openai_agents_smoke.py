from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from actledger import Ledger
from actledger.gate import ToolGate

pytestmark = [pytest.mark.openai_agents, pytest.mark.node, pytest.mark.openai_api]


def _init_mail(cli, directory: Path) -> None:
    policy = directory.parent / "mail-policy.yaml"
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
  tool.send_email: { level: send }
rules:
  - id: send-approve
    match: { action: tool.send_email }
    effect: require_approval
""".lstrip(),
        encoding="utf-8",
    )
    result = cli(["init", "--dir", str(directory), "--policy", str(policy)])
    assert result.returncode == 0, result.stderr or result.stdout


def test_real_model_interrupts_then_executes_after_cli_approve(tmp_path: Path, cli) -> None:
    import os

    from agents import Agent, Runner, set_tracing_disabled

    from actledger.openai_agents import openai_agents_ledger, resolve_interruptions

    set_tracing_disabled(True)
    directory = tmp_path / "ledger"
    _init_mail(cli, directory)
    model = os.environ.get("OPENAI_DEFAULT_MODEL")

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="defer")
            binding = openai_agents_ledger(gate, ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                return f"sent to {to}"

            agent = Agent(
                name="mailer",
                instructions="You send email only by calling send_email. After it returns, say done.",
                tools=[send_email],
                **({"model": model} if model else {}),
            )
            try:
                result = await Runner.run(
                    agent,
                    "Call the send_email tool now with to bob@example.com and body ready. Do not do anything else first.",
                    max_turns=4,
                )
                assert len(result.interruptions) >= 1
                listed = cli(["tasks", "--dir", str(directory), "--state", "pending_approval", "--json"])
                assert listed.returncode == 0, listed.stderr or listed.stdout
                for task in json.loads(listed.stdout or "[]"):
                    approved = cli(
                        ["approve", task["id"], "--dir", str(directory), "--assurance", "channel_verified"],
                    )
                    assert approved.returncode == 0, approved.stderr or approved.stdout
                resolved = await resolve_interruptions(result, binding)
                assert resolved.pending == []
                assert resolved.approved
                await Runner.run(agent, resolved.state, max_turns=4)
                finished = cli(["tasks", "--dir", str(directory), "--json"])
                assert finished.returncode == 0, finished.stderr or finished.stdout
                tasks = json.loads(finished.stdout)
                assert any(item.get("state") == "executed" for item in tasks)
            finally:
                await binding.abandon()

    asyncio.run(main())
