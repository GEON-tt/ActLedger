from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from actledger import (
    ApprovalRejected,
    ContentMismatch,
    Ledger,
    LedgerError,
    ToolGate,
    approve_hint,
    default_tool_mapping,
)

FIXTURES = Path(__file__).parent / "fixtures"


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


def _approve_pending(cli, directory: Path) -> None:
    task_id = _pending_id(cli, directory)
    approved = cli(
        ["approve", task_id, "--dir", str(directory), "--assurance", "channel_verified"],
    )
    assert approved.returncode == 0, approved.stderr or approved.stdout


def _reject_pending(cli, directory: Path) -> None:
    task_id = _pending_id(cli, directory)
    rejected = cli(["reject", task_id, "--dir", str(directory), "--note", "no"])
    assert rejected.returncode == 0, rejected.stderr or rejected.stdout


def test_default_mapping_action_type() -> None:
    mapped = default_tool_mapping("search", {"q": "x"})
    assert mapped.action == {"type": "tool.search"}
    assert mapped.payload == {"action": "tool.search", "args": {"q": "x"}}
    raw = default_tool_mapping("search", "raw")
    assert raw.payload == {"action": "tool.search", "args": {"input": "raw"}}
    assert "actledger approve tsk_1 --dir /d" in approve_hint("tsk_1", "/d")


@pytest.mark.node
def test_wait_allow_by_policy_and_complete(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait")
        decision = gate.before("search", {"q": "x"})
        assert decision.kind == "allow"
        assert decision.approved_payload == {"action": "tool.search", "args": {"q": "x"}}
        receipt = gate.after(decision.run, result={"hits": 1})
        assert isinstance(receipt, dict)
        assert str(receipt["hash"]).startswith("sha256:")
        task = ledger.get_task(decision.task_id)
        assert task is not None
        assert task.state == "executed"
        assert task.data["action"]["type"] == "tool.search"


@pytest.mark.node
def test_wait_allow_after_cli_approve(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait", timeout=20, poll_interval=0.02)
        worker = threading.Thread(target=_approve_pending, args=(cli, directory))
        worker.start()
        try:
            decision = gate.before("send_email", {"to": "a@example.com"})
        finally:
            worker.join(timeout=25)
        assert decision.kind == "allow"
        gate.after(decision.run, result={"sent": True})
        task = ledger.get_task(decision.task_id)
        assert task is not None
        assert task.state == "executed"


@pytest.mark.node
def test_wait_deny_policy(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait")
        decision = gate.before("drop_table", {})
        assert decision.kind == "deny"
        assert decision.reason == "policy_denied"
        assert isinstance(decision.cause, ApprovalRejected)


@pytest.mark.node
def test_wait_deny_reject(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait", timeout=20, poll_interval=0.02)
        worker = threading.Thread(target=_reject_pending, args=(cli, directory))
        worker.start()
        try:
            decision = gate.before("send_email", {"to": "a@example.com"})
        finally:
            worker.join(timeout=25)
        assert decision.kind == "deny"
        assert decision.reason == "rejected"


@pytest.mark.node
def test_wait_deny_drafted(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait")
        decision = gate.before("draft_post", {})
        assert decision.kind == "deny"
        assert decision.reason == "drafted"
        assert isinstance(decision.cause, LedgerError)
        assert decision.cause.code == "invalid_transition"


@pytest.mark.node
def test_wait_timeout(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait", timeout=0.1, poll_interval=0.02)
        decision = gate.before("send_email", {"to": "a@example.com"})
        assert decision.kind == "deny"
        assert decision.reason == "timeout"
        assert decision.state == "pending_approval"
        task = ledger.get_task(decision.task_id)
        assert task is not None
        assert task.state == "pending_approval"


@pytest.mark.node
def test_defer_pending_then_resume_allow(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="defer")
        pending = gate.before("send_email", {"to": "a@example.com"})
        assert pending.kind == "pending"
        assert f"actledger approve {pending.task_id}" in pending.approve_hint
        assert f"--dir {ledger.dir}" in pending.approve_hint
        assert gate.resume(pending.task_id).kind == "pending"
        approved = cli(
            ["approve", pending.task_id, "--dir", str(directory), "--assurance", "channel_verified"],
        )
        assert approved.returncode == 0, approved.stderr or approved.stdout
        allowed = gate.resume(pending.task_id)
        assert allowed.kind == "allow"
        gate.after(allowed.run, result={"sent": True})
        task = ledger.get_task(pending.task_id)
        assert task is not None
        assert task.state == "executed"
        with pytest.raises(LedgerError) as caught:
            gate.resume(pending.task_id)
        assert caught.value.code == "invalid_transition"


@pytest.mark.node
def test_defer_resume_deny_reject_and_revoke(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="defer")
        pending = gate.before("send_email", {"to": "a@example.com"})
        assert pending.kind == "pending"
        rejected = cli(["reject", pending.task_id, "--dir", str(directory), "--note", "no"])
        assert rejected.returncode == 0, rejected.stderr or rejected.stdout
        denied = gate.resume(pending.task_id)
        assert denied.kind == "deny"
        assert denied.reason == "rejected"

        again = gate.before("send_email", {"to": "b@example.com"})
        assert again.kind == "pending"
        ledger.revoke(again.task_id)
        revoked = gate.resume(again.task_id)
        assert revoked.kind == "deny"
        assert revoked.reason == "revoked"


@pytest.mark.node
def test_after_error_fails_task(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait")
        decision = gate.before("search", {"q": "x"})
        assert decision.kind == "allow"
        assert gate.after(decision.run, error=RuntimeError("boom")) is None
        task = ledger.get_task(decision.task_id)
        assert task is not None
        assert task.state == "failed"
        assert task.data["error"]["code"] == "tool_error"
        with pytest.raises(TypeError):
            gate.after(decision.run)


@pytest.mark.node
def test_after_strict_mismatch(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="wait")
        decision = gate.before("search", {"q": "x"})
        assert decision.kind == "allow"
        with pytest.raises(ContentMismatch):
            gate.after(
                decision.run,
                result=1,
                executed_payload={"action": "tool.search", "args": {"q": "other"}},
            )
        task = ledger.get_task(decision.task_id)
        assert task is not None
        assert task.state == "failed"
        assert task.data["error"]["code"] == "content_mismatch"


@pytest.mark.node
def test_principal_callable_and_custom_map(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        fixed = ToolGate(ledger, principal="u_fixed", mode="wait")
        allowed = fixed.before("search", {"q": "x"})
        assert allowed.kind == "allow"
        stored = ledger.get_task(allowed.task_id)
        assert stored is not None
        assert stored.data["principalId"] == "u_fixed"

        gate = ToolGate(
            ledger,
            principal=lambda name, inp: f"u_{name}",
            mode="defer",
            map=lambda name, inp: {"action": "calendar.create", "payload": {"action": "x", "args": {}}},
        )
        pending = gate.before("search", {})
        assert pending.kind == "pending"
        created = ledger.get_task(pending.task_id)
        assert created is not None
        assert created.data["principalId"] == "u_search"
        assert created.data["action"]["type"] == "calendar.create"
        approved = cli(["approve", pending.task_id, "--dir", str(directory)])
        assert approved.returncode == 0, approved.stderr or approved.stdout
        decision = gate.resume(pending.task_id)
        assert decision.kind == "allow"
        assert decision.approved_payload["action"] == "calendar.create"


@pytest.mark.node
def test_resume_not_found(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)
    with Ledger(dir=directory) as ledger:
        gate = ToolGate(ledger, principal="u_1", mode="defer")
        with pytest.raises(LedgerError) as caught:
            gate.resume("tsk_nope")
        assert caught.value.code == "not_found"


@pytest.mark.node
def test_async_methods(tmp_path: Path, cli) -> None:
    directory = tmp_path / "ledger"
    _init_gate(cli, directory)

    async def main() -> None:
        with Ledger(dir=directory) as ledger:
            gate = ToolGate(ledger, principal="u_1", mode="wait")
            decision = await gate.async_before("search", {"q": "x"})
            assert decision.kind == "allow"
            await gate.async_after(decision.run, result=1)
            task = ledger.get_task(decision.task_id)
            assert task is not None
            assert task.state == "executed"

            defer = ToolGate(ledger, principal="u_1", mode="defer")
            pending = await defer.async_before("send_email", {"to": "a@example.com"})
            assert pending.kind == "pending"
            approved = await asyncio.to_thread(
                cli,
                ["approve", pending.task_id, "--dir", str(directory), "--assurance", "channel_verified"],
            )
            assert approved.returncode == 0, approved.stderr or approved.stdout
            allowed = await defer.async_resume(pending.task_id)
            assert allowed.kind == "allow"
            assert await defer.async_after(allowed.run, error=RuntimeError("x")) is None
            failed = ledger.get_task(pending.task_id)
            assert failed is not None
            assert failed.state == "failed"

            denied = await gate.async_before("drop_table", {})
            assert denied.kind == "deny"

    asyncio.run(main())
