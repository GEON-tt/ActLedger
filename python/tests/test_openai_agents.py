from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from actledger import Ledger, LedgerError
from actledger.gate import ToolGate

FIXTURES = Path(__file__).parent / "fixtures"

pytestmark = [pytest.mark.openai_agents, pytest.mark.node]


@pytest.fixture
def mods():
    from agents import Agent, Runner, WebSearchTool, function_tool, set_tracing_disabled
    from agents.run_state import RunState
    from agents.testing import ScriptedModel, assistant_message, function_call

    from actledger.openai_agents import (
        SDK_DEFAULT_TOOL_ERROR,
        deny_message,
        openai_agents_ledger,
        resolve_interruptions,
        with_ledger,
        with_ledger_agent,
    )

    set_tracing_disabled(True)
    return SimpleNamespace(
        Agent=Agent,
        Runner=Runner,
        WebSearchTool=WebSearchTool,
        function_tool=function_tool,
        RunState=RunState,
        ScriptedModel=ScriptedModel,
        assistant_message=assistant_message,
        function_call=function_call,
        SDK_DEFAULT_TOOL_ERROR=SDK_DEFAULT_TOOL_ERROR,
        deny_message=deny_message,
        openai_agents_ledger=openai_agents_ledger,
        resolve_interruptions=resolve_interruptions,
        with_ledger=with_ledger,
        with_ledger_agent=with_ledger_agent,
    )


def _init_gate(cli, directory: Path) -> None:
    result = cli(["init", "--dir", str(directory), "--policy", str(FIXTURES / "gate-policy.yaml")])
    assert result.returncode == 0, result.stderr or result.stdout


def _tasks(cli, directory: Path) -> list:
    listed = cli(["tasks", "--dir", str(directory), "--json"])
    assert listed.returncode == 0, listed.stderr or listed.stdout
    return json.loads(listed.stdout) if listed.stdout.strip() else []


def _pending_id(cli, directory: Path) -> str:
    deadline = time.time() + 20
    while time.time() < deadline:
        listed = cli(["tasks", "--dir", str(directory), "--state", "pending_approval", "--json"])
        assert listed.returncode == 0, listed.stderr
        tasks = json.loads(listed.stdout) if listed.stdout.strip() else []
        if tasks:
            return tasks[0]["id"]
        time.sleep(0.05)
    raise AssertionError("no pending task")


def _approve(cli, directory: Path) -> str:
    task_id = _pending_id(cli, directory)
    approved = cli(["approve", task_id, "--dir", str(directory), "--assurance", "channel_verified"])
    assert approved.returncode == 0, approved.stderr or approved.stdout
    return task_id


def _approve_edit(cli, directory: Path, edit_file: Path) -> str:
    task_id = _pending_id(cli, directory)
    approved = cli(
        ["approve", task_id, "--dir", str(directory), "--edit", str(edit_file), "--assurance", "channel_verified"],
    )
    assert approved.returncode == 0, approved.stderr or approved.stdout
    return task_id


def _reject(cli, directory: Path) -> str:
    task_id = _pending_id(cli, directory)
    rejected = cli(["reject", task_id, "--dir", str(directory), "--note", "no"])
    assert rejected.returncode == 0, rejected.stderr or rejected.stdout
    return task_id


def _receipts(cli, directory: Path, task_id: str) -> list:
    exported = cli(["export", "--dir", str(directory)])
    assert exported.returncode == 0, exported.stderr or exported.stdout
    rows = []
    for line in exported.stdout.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("task_id") == task_id:
            rows.append(row)
    return rows


def _claim_count(cli, directory: Path, task_id: str) -> int:
    return sum(1 for row in _receipts(cli, directory, task_id) if (row.get("transition") or {}).get("to") == "executing")


def _tool_outputs(result) -> list:
    return [item.output for item in result.new_items if getattr(item, "type", None) == "tool_call_output_item"]


def _agent(mods, model_steps, tools):
    model = mods.ScriptedModel(model_steps)
    return mods.Agent(name="t", model=model, tools=tools)


class _ModeGate:
    def __init__(self, mode: str) -> None:
        self.mode = mode


class _BoomGate:
    mode = "defer"

    async def async_before(self, tool_name: str, params: dict) -> None:
        del tool_name, params
        raise LedgerError("ledger_unavailable", "down", 503)


class _QuietLedger:
    dir = None

    def sweep(self) -> None:
        return None

    def get_task(self, task_id: str):
        del task_id
        return None


def test_rejects_wait_mode_gate(mods) -> None:
    with pytest.raises(TypeError, match="defer-mode ToolGate"):
        mods.openai_agents_ledger(_ModeGate("wait"), object())


def test_binding_has_no_approve_or_reject(mods) -> None:
    binding = mods.openai_agents_ledger(_ModeGate("defer"), object())
    assert not hasattr(binding, "approve")
    assert not hasattr(binding, "reject")
    assert binding.in_flight == 0


def test_function_tool_refuses_needs_approval(mods) -> None:
    binding = mods.openai_agents_ledger(_ModeGate("defer"), object())

    def send_email(to: str) -> str:
        """Send."""
        return to

    with pytest.raises(TypeError, match="needs_approval"):
        binding.function_tool(send_email, needs_approval=True)


def test_defer_pending_interrupts_and_does_not_execute(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                counts["n"] += 1
                return f"sent to {to} {body}"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            assert len(result.interruptions) == 1
            assert result.interruptions[0].call_id == "call_1"
            assert counts["n"] == 0
            tasks = _tasks(cli, directory)
            assert len(tasks) == 1
            assert tasks[0]["state"] == "pending_approval"
            assert _claim_count(cli, directory, tasks[0]["id"]) == 0

    asyncio.run(main())


def test_pending_stays_pending_and_state_untouched(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                return to + body

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            resolved = await mods.resolve_interruptions(result, binding)
            assert len(resolved.pending) == 1
            assert "actledger approve" in resolved.pending[0][2]
            assert len(resolved.state.get_interruptions()) == 1
            assert _tasks(cli, directory)[0]["state"] == "pending_approval"

    asyncio.run(main())


def test_cli_approve_then_resolve_executes_once_and_receipt_executed(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                counts["n"] += 1
                return "sent"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            task_id = _approve(cli, directory)
            resolved = await mods.resolve_interruptions(result, binding)
            assert len(resolved.approved) == 1
            resumed = await mods.Runner.run(agent, resolved.state)
            assert counts["n"] == 1
            handle = ledger.get_task(task_id)
            assert handle is not None and handle.state == "executed"
            assert _claim_count(cli, directory, task_id) == 1
            assert _receipts(cli, directory, task_id)[-1]["transition"]["to"] == "executed"
            assert resumed.final_output == "done"

    asyncio.run(main())


def test_claim_happens_in_execute_not_in_resolve(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                return "sent"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            task_id = _approve(cli, directory)
            resolved = await mods.resolve_interruptions(result, binding)
            assert _claim_count(cli, directory, task_id) == 0
            handle = ledger.get_task(task_id)
            assert handle is not None and handle.state == "approved"
            await mods.Runner.run(agent, resolved.state)
            assert _claim_count(cli, directory, task_id) == 1

    asyncio.run(main())


def test_cli_approve_with_edit_passes_edited_args(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    edit_file = tmp_path / "edit.json"
    edit_file.write_text(
        json.dumps({"action": "tool.send_email", "args": {"to": "c@d", "body": "hi"}}),
        encoding="utf-8",
    )
    seen: dict = {}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                seen["to"] = to
                seen["body"] = body
                return "sent"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            _approve_edit(cli, directory, edit_file)
            resolved = await mods.resolve_interruptions(result, binding)
            await mods.Runner.run(agent, resolved.state)
            assert seen["to"] == "c@d"
            assert seen["body"] == "hi"

    asyncio.run(main())


def test_cli_reject_then_resolve_rejects_and_tool_never_runs(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                counts["n"] += 1
                return "sent"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            task_id = _reject(cli, directory)
            resolved = await mods.resolve_interruptions(result, binding)
            assert resolved.rejected[0][2] == "rejected"
            resumed = await mods.Runner.run(agent, resolved.state)
            assert counts["n"] == 0
            assert _claim_count(cli, directory, task_id) == 0
            handle = ledger.get_task(task_id)
            assert handle is not None and handle.state == "rejected"
            assert _receipts(cli, directory, task_id)[-1]["transition"]["to"] == "rejected"
            assert mods.deny_message("send_email", "rejected", task_id) in _tool_outputs(resumed)

    asyncio.run(main())


def test_policy_deny_is_rejected_without_human(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def drop_table() -> str:
                """Drop a table."""
                counts["n"] += 1
                return "dropped"

            agent = _agent(
                mods,
                [[mods.function_call("drop_table", {}, call_id="call_1")], [mods.assistant_message("done")]],
                [drop_table],
            )
            result = await mods.Runner.run(agent, "go")
            assert len(result.interruptions) == 1
            resolved = await mods.resolve_interruptions(result, binding)
            assert resolved.rejected[0][2] == "policy_denied"
            assert counts["n"] == 0
            assert binding._store == {}

    asyncio.run(main())


def test_auto_approved_tool_executes_once_without_interruption(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def search(q: str) -> str:
                """Search."""
                counts["n"] += 1
                return q

            agent = _agent(
                mods,
                [[mods.function_call("search", {"q": "x"}, call_id="call_1")], [mods.assistant_message("done")]],
                [search],
            )
            result = await mods.Runner.run(agent, "go")
            assert result.interruptions == []
            assert counts["n"] == 1
            tasks = _tasks(cli, directory)
            assert tasks[0]["state"] == "executed"
            assert _claim_count(cli, directory, tasks[0]["id"]) == 1
            assert binding.in_flight == 0

    asyncio.run(main())


def test_function_tool_timeout_fails_cancelled(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool(timeout=0.2)
            async def search(q: str) -> str:
                """Search."""
                await asyncio.sleep(2)
                return q

            agent = _agent(
                mods,
                [[mods.function_call("search", {"q": "x"}, call_id="call_1")], [mods.assistant_message("done")]],
                [search],
            )
            result = await mods.Runner.run(agent, "go")
            tasks = _tasks(cli, directory)
            handle = ledger.get_task(tasks[0]["id"])
            assert handle is not None
            assert handle.state == "failed"
            assert handle.state != "executing"
            assert handle.data["error"]["code"] == "cancelled"
            assert binding.in_flight == 0
            assert any("timed out" in str(item) for item in _tool_outputs(result))
            assert all(row.get("transition", {}).get("to") != "executed" for row in _receipts(cli, directory, tasks[0]["id"]))

    asyncio.run(main())


def test_execute_error_fails_task_with_tool_error(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                raise RuntimeError("smtp down")

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            task_id = _approve(cli, directory)
            resolved = await mods.resolve_interruptions(result, binding)
            resumed = await mods.Runner.run(agent, resolved.state)
            handle = ledger.get_task(task_id)
            assert handle is not None
            assert handle.state == "failed"
            assert handle.data["error"]["code"] == "tool_error"
            assert mods.SDK_DEFAULT_TOOL_ERROR in _tool_outputs(resumed)
            assert all(row.get("transition", {}).get("to") != "executed" for row in _receipts(cli, directory, task_id))

    asyncio.run(main())


def test_with_ledger_existing_tool_default_error_string_fails(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def search(q: str) -> str:
        """Search."""
        raise RuntimeError("boom")

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)
            original = mods.function_tool(search)
            wrapped = mods.with_ledger(original, binding)
            agent = _agent(
                mods,
                [[mods.function_call("search", {"q": "x"}, call_id="call_1")], [mods.assistant_message("done")]],
                [wrapped],
            )
            result = await mods.Runner.run(agent, "go")
            tasks = _tasks(cli, directory)
            handle = ledger.get_task(tasks[0]["id"])
            assert handle is not None and handle.state == "failed"
            assert handle.data["error"]["code"] == "tool_error"
            assert mods.SDK_DEFAULT_TOOL_ERROR in _tool_outputs(result)
            assert mods.SDK_DEFAULT_TOOL_ERROR == "An error occurred while running the tool. Please try again."

    asyncio.run(main())


def test_with_ledger_agent_wraps_function_tools(mods) -> None:
    seen: list = []

    async def search(q: str) -> str:
        """Search."""
        return q

    binding = mods.openai_agents_ledger(_ModeGate("defer"), object(), on_unsupported_tool=seen.append)
    original = mods.function_tool(search)
    hosted = mods.WebSearchTool()
    agent = mods.Agent(name="t", tools=[original, hosted])
    wrapped = mods.with_ledger_agent(agent, binding)
    assert wrapped.tools[0].needs_approval != original.needs_approval
    assert agent.tools[0] is original
    assert seen == [hosted]


def test_serialized_state_resume_single_task(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                counts["n"] += 1
                return "sent"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            saved = result.to_state().to_string()
            restored = await mods.RunState.from_string(agent, saved)
            _approve(cli, directory)
            resolved = await mods.resolve_interruptions(restored, binding)
            await mods.Runner.run(agent, resolved.state)
            assert len(_tasks(cli, directory)) == 1
            assert counts["n"] == 1
            assert _claim_count(cli, directory, _tasks(cli, directory)[0]["id"]) == 1

    asyncio.run(main())


def test_revoked_between_resolve_and_resume_does_not_execute(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    counts = {"n": 0}

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def send_email(to: str, body: str) -> str:
                """Send an email."""
                counts["n"] += 1
                return "sent"

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            task_id = _approve(cli, directory)
            resolved = await mods.resolve_interruptions(result, binding)
            ledger.revoke(task_id)
            resumed = await mods.Runner.run(agent, resolved.state)
            assert counts["n"] == 0
            assert _claim_count(cli, directory, task_id) == 0
            assert any("revoked" in str(item) for item in _tool_outputs(resumed))

    asyncio.run(main())


def test_ledger_error_in_needs_approval_fails_closed(mods) -> None:
    seen: list = []

    def on_error(error: BaseException, context: dict) -> None:
        seen.append((error, context))

    binding = mods.openai_agents_ledger(_BoomGate(), _QuietLedger(), on_error=on_error)
    counts = {"n": 0}

    async def main():
        @binding.function_tool
        async def send_email(to: str, body: str) -> str:
            """Send an email."""
            counts["n"] += 1
            return "sent"

        agent = _agent(
            mods,
            [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")]],
            [send_email],
        )
        result = await mods.Runner.run(agent, "go")
        resolved = await mods.resolve_interruptions(result, binding)
        return resolved

    resolved = asyncio.run(main())
    assert resolved.rejected[0][2] == "ledger_error"
    assert seen and seen[0][1]["phase"] == "before"
    assert counts["n"] == 0
    assert binding._store == {}


def test_abandon_fails_held_runs(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            async def search(q: str) -> str:
                """Search."""
                return q

            await search.needs_approval(None, {"q": "x"}, "c1")
            assert binding.in_flight == 1
            await binding.abandon()
            assert binding.in_flight == 0
            tasks = _tasks(cli, directory)
            handle = ledger.get_task(tasks[0]["id"])
            assert handle is not None
            assert handle.state == "failed"
            assert handle.data["error"]["code"] == "abandoned"

    asyncio.run(main())


def test_untracked_interruptions_left_alone(mods) -> None:
    async def send_email(to: str, body: str) -> str:
        """Send an email."""
        return to + body

    async def main():
        binding = mods.openai_agents_ledger(_ModeGate("defer"), _QuietLedger())
        native = mods.function_tool(send_email, needs_approval=True)
        agent = _agent(
            mods,
            [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")]],
            [native],
        )
        result = await mods.Runner.run(agent, "go")
        resolved = await mods.resolve_interruptions(result, binding)
        assert len(resolved.untracked) == 1
        assert resolved.approved == []
        assert resolved.rejected == []
        assert len(resolved.state.get_interruptions()) == 1

    asyncio.run(main())


def test_sync_function_tool_error_is_captured(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            binding = mods.openai_agents_ledger(ToolGate(ledger, principal="u_1", mode="defer"), ledger)

            @binding.function_tool
            def send_email(to: str, body: str) -> str:
                """Send an email."""
                raise RuntimeError("smtp down")

            agent = _agent(
                mods,
                [[mods.function_call("send_email", {"to": "a@b", "body": "hi"}, call_id="call_1")], [mods.assistant_message("done")]],
                [send_email],
            )
            result = await mods.Runner.run(agent, "go")
            task_id = _approve(cli, directory)
            resolved = await mods.resolve_interruptions(result, binding)
            await mods.Runner.run(agent, resolved.state)
            handle = ledger.get_task(task_id)
            assert handle is not None
            assert handle.state == "failed"
            assert handle.data["error"]["code"] == "tool_error"

    asyncio.run(main())
