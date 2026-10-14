from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from actledger import Ledger, LedgerError, ToolGate

FIXTURES = Path(__file__).parent / "fixtures"

pytestmark = [pytest.mark.claude, pytest.mark.node]


@pytest.fixture
def mods():
    from actledger.claude_agent import ClaudeAgentAdapter, claude_agent_adapter
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        HookMatcher,
        PermissionResultAllow,
        PermissionResultDeny,
        ToolPermissionContext,
    )

    return SimpleNamespace(
        ClaudeAgentAdapter=ClaudeAgentAdapter,
        claude_agent_adapter=claude_agent_adapter,
        ClaudeAgentOptions=ClaudeAgentOptions,
        HookMatcher=HookMatcher,
        PermissionResultAllow=PermissionResultAllow,
        PermissionResultDeny=PermissionResultDeny,
        ToolPermissionContext=ToolPermissionContext,
    )


def _init_gate(cli, directory: Path) -> None:
    result = cli(["init", "--dir", str(directory), "--policy", str(FIXTURES / "gate-policy.yaml")])
    assert result.returncode == 0, result.stderr or result.stdout


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


def _approve_edit(cli, directory: Path, edit_file: Path) -> None:
    task_id = _pending_id(cli, directory)
    approved = cli(
        ["approve", task_id, "--dir", str(directory), "--edit", str(edit_file), "--assurance", "channel_verified"],
    )
    assert approved.returncode == 0, approved.stderr or approved.stdout


def _reject_pending(cli, directory: Path) -> None:
    task_id = _pending_id(cli, directory)
    rejected = cli(["reject", task_id, "--dir", str(directory), "--note", "no"])
    assert rejected.returncode == 0, rejected.stderr or rejected.stdout


def _ctx(mods, tool_use_id: str):
    return mods.ToolPermissionContext(tool_use_id=tool_use_id)


def _post(tool_name, tool_use_id, tool_input, tool_response) -> dict:
    return {
        "hook_event_name": "PostToolUse",
        "session_id": "s_1",
        "transcript_path": "/tmp/t.jsonl",
        "cwd": "/tmp",
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_response": tool_response,
        "tool_use_id": tool_use_id,
    }


def _failure(tool_name, tool_use_id, tool_input, error, is_interrupt=False) -> dict:
    body = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": "s_1",
        "transcript_path": "/tmp/t.jsonl",
        "cwd": "/tmp",
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_use_id": tool_use_id,
        "error": error,
    }
    if is_interrupt:
        body["is_interrupt"] = True
    return body


def _only_task(cli, directory: Path, ledger: Ledger):
    listed = cli(["tasks", "--dir", str(directory), "--json"])
    assert listed.returncode == 0, listed.stderr or listed.stdout
    tasks = json.loads(listed.stdout)
    assert len(tasks) == 1
    handle = ledger.get_task(tasks[0]["id"])
    assert handle is not None
    return handle


class _ModeGate:
    def __init__(self, mode: str) -> None:
        self.mode = mode


class _BoomGate:
    mode = "wait"

    async def async_before(self, tool_name: str, tool_input: dict) -> None:
        del tool_name, tool_input
        raise LedgerError("ledger_unavailable", "down", 503)


def test_rejects_defer_mode_gate(mods) -> None:
    with pytest.raises(TypeError, match="wait-mode ToolGate"):
        mods.claude_agent_adapter(_ModeGate("defer"))


def test_adapter_has_no_approve_or_reject(mods) -> None:
    adapter = mods.claude_agent_adapter(_ModeGate("wait"))
    assert not hasattr(adapter, "approve")
    assert not hasattr(adapter, "reject")


def test_allow_auto_approved_returns_permission_result_allow_with_args(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = mods.claude_agent_adapter(gate)
            result = await adapter.can_use_tool("search", {"q": "x"}, _ctx(mods, "tu_search"))
            assert isinstance(result, mods.PermissionResultAllow)
            assert result.updated_input == {"q": "x"}
            assert adapter.in_flight == 1

    asyncio.run(main())


def test_allow_after_cli_approve_with_edit_passes_edited_args(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    edit_file = tmp_path / "edit.json"
    edit_file.write_text(
        json.dumps({"action": "tool.send_email", "args": {"to": "b@example.com"}}),
        encoding="utf-8",
    )

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait", timeout=20, poll_interval=0.02)
            adapter = mods.claude_agent_adapter(gate)
            worker = threading.Thread(target=_approve_edit, args=(cli, directory, edit_file))
            worker.start()
            try:
                result = await adapter.can_use_tool(
                    "send_email",
                    {"to": "a@example.com"},
                    _ctx(mods, "tu_edit"),
                )
            finally:
                worker.join(timeout=25)
            assert isinstance(result, mods.PermissionResultAllow)
            assert result.updated_input == {"to": "b@example.com"}

    asyncio.run(main())


def test_deny_policy_returns_permission_result_deny_with_task_id_and_reason(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = mods.claude_agent_adapter(gate)
            result = await adapter.can_use_tool("drop_table", {}, _ctx(mods, "tu_drop"))
            assert isinstance(result, mods.PermissionResultDeny)
            assert "tsk_" in result.message
            assert "policy_denied" in result.message
            assert "drop_table" in result.message
            assert result.interrupt is False

    asyncio.run(main())


def test_deny_reject_while_waiting(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait", timeout=20, poll_interval=0.02)
            adapter = mods.claude_agent_adapter(gate)
            worker = threading.Thread(target=_reject_pending, args=(cli, directory))
            worker.start()
            try:
                result = await adapter.can_use_tool(
                    "send_email",
                    {"to": "a@example.com"},
                    _ctx(mods, "tu_reject"),
                )
            finally:
                worker.join(timeout=25)
            assert isinstance(result, mods.PermissionResultDeny)
            assert "rejected" in result.message
            assert "tsk_" in result.message

    asyncio.run(main())


def test_deny_timeout(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait", timeout=0.3, poll_interval=0.02)
            adapter = mods.claude_agent_adapter(gate)
            result = await adapter.can_use_tool("send_email", {"to": "a@example.com"}, _ctx(mods, "tu_timeout"))
            assert isinstance(result, mods.PermissionResultDeny)
            assert "timeout" in result.message
            task = _only_task(cli, directory, ledger)
            assert task.state == "pending_approval"

    asyncio.run(main())


def test_ledger_error_fails_closed_and_calls_on_error(mods) -> None:
    seen: list[tuple[BaseException, dict]] = []

    def on_error(error: BaseException, context: dict) -> None:
        seen.append((error, context))

    adapter = mods.claude_agent_adapter(_BoomGate(), on_error=on_error)

    async def main():
        return await adapter.can_use_tool("search", {"q": "x"}, _ctx(mods, "tu_down"))

    result = asyncio.run(main())
    assert isinstance(result, mods.PermissionResultDeny)
    assert "ledger error" in result.message
    assert seen and seen[0][1]["phase"] == "before"
    assert isinstance(seen[0][0], LedgerError)
    assert adapter.in_flight == 0


def test_after_success_completes_task(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = mods.claude_agent_adapter(gate)
            await adapter.can_use_tool("search", {"q": "x"}, _ctx(mods, "tu_ok"))
            output = await adapter.post_tool_use(_post("search", "tu_ok", {"q": "x"}, {"hits": 1}), "tu_ok", {})
            assert output == {}
            assert adapter.in_flight == 0
            task = _only_task(cli, directory, ledger)
            assert task.state == "executed"

    asyncio.run(main())


def test_after_failure_fails_task(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = mods.claude_agent_adapter(gate)
            await adapter.can_use_tool("search", {"q": "x"}, _ctx(mods, "tu_fail"))
            output = await adapter.post_tool_use_failure(
                _failure("search", "tu_fail", {"q": "x"}, "boom"),
                "tu_fail",
                {},
            )
            assert output == {}
            assert adapter.in_flight == 0
            task = _only_task(cli, directory, ledger)
            assert task.state == "failed"
            assert task.data["error"]["code"] == "tool_error"

    asyncio.run(main())


def test_after_is_error_result_fails_task(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = mods.claude_agent_adapter(gate)
            await adapter.can_use_tool("search", {"q": "x"}, _ctx(mods, "tu_mcp"))
            response = {"isError": True, "content": [{"type": "text", "text": "nope"}]}
            await adapter.post_tool_use(_post("search", "tu_mcp", {"q": "x"}, response), "tu_mcp", {})
            task = _only_task(cli, directory, ledger)
            assert task.state == "failed"
            assert task.data["error"]["code"] == "tool_error"

    asyncio.run(main())


def test_untracked_tool_use_id_is_noop(mods) -> None:
    seen: list[tuple[str, str | None]] = []

    def on_untracked(tool_name: str, tool_use_id: str | None) -> None:
        seen.append((tool_name, tool_use_id))

    adapter = mods.claude_agent_adapter(_ModeGate("wait"), on_untracked=on_untracked)

    async def main() -> dict:
        return await adapter.post_tool_use(_post("Read", "tu_free", {}, "ok"), "tu_free", {})

    assert asyncio.run(main()) == {}
    assert seen == [("Read", "tu_free")]
    assert adapter.in_flight == 0


def test_abandon_fails_in_flight_runs(tmp_path: Path, cli, mods) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            adapter = mods.claude_agent_adapter(gate)
            await adapter.can_use_tool("search", {"q": "a"}, _ctx(mods, "tu_a"))
            await adapter.can_use_tool("search", {"q": "b"}, _ctx(mods, "tu_b"))
            assert adapter.in_flight == 2
            await adapter.abandon()
            assert adapter.in_flight == 0
            listed = cli(["tasks", "--dir", str(directory), "--json"])
            assert listed.returncode == 0, listed.stderr
            tasks = json.loads(listed.stdout)
            assert len(tasks) == 2
            for item in tasks:
                handle = ledger.get_task(item["id"])
                assert handle is not None
                assert handle.state == "failed"
                assert handle.data["error"]["code"] == "abandoned"

    asyncio.run(main())


def test_options_merges_hooks_and_refuses_existing_can_use_tool(mods) -> None:
    adapter = mods.claude_agent_adapter(_ModeGate("wait"))

    async def other(hook_input: dict, tool_use_id: str | None, context: dict) -> dict:
        del hook_input, tool_use_id, context
        return {}

    base = mods.ClaudeAgentOptions(hooks={"PostToolUse": [mods.HookMatcher(hooks=[other])]})
    merged = adapter.options(base)
    assert len(merged.hooks["PostToolUse"]) == 2
    assert merged.can_use_tool.__func__ is adapter.can_use_tool.__func__
    with pytest.raises(TypeError, match="can_use_tool"):
        adapter.options(mods.ClaudeAgentOptions(can_use_tool=adapter.can_use_tool))
    with pytest.raises(TypeError, match="permission_prompt_tool_name"):
        adapter.options(mods.ClaudeAgentOptions(permission_prompt_tool_name="Ask"))


def test_hooks_shape_matches_sdk(mods) -> None:
    adapter = mods.claude_agent_adapter(_ModeGate("wait"))
    post = adapter.hooks["PostToolUse"][0]
    assert isinstance(post, mods.HookMatcher)
    assert post.hooks[0].__func__ is mods.ClaudeAgentAdapter.post_tool_use
    failure = adapter.hooks["PostToolUseFailure"][0]
    assert isinstance(failure, mods.HookMatcher)
    assert failure.hooks[0].__func__ is mods.ClaudeAgentAdapter.post_tool_use_failure
