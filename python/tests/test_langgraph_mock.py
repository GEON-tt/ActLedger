from __future__ import annotations

import json
from pathlib import Path

import pytest

from actledger.errors import LedgerError
from actledger.langgraph import ledger_gate


class Suspend(Exception):
    pass


def test_core_import_does_not_load_langgraph() -> None:
    import subprocess
    import sys

    subprocess.check_call(
        [
            sys.executable,
            "-c",
            "import sys, actledger, actledger.langgraph; assert 'langgraph' not in sys.modules; assert actledger.jcs(True) == 'true'",
        ]
    )


class FakeRun:
    def __init__(self, ledger: FakeLedger) -> None:
        self.task_id = ledger.task_id
        self.approved_payload = ledger.approved
        self.execution_deadline = "2099-01-01T00:00:00.000Z"
        self._ledger = ledger

    def complete(self, *, executed_payload, external_proofs=None, result=None, idempotency_key=None):
        self._ledger.completes.append({"payload": executed_payload, "proofs": external_proofs})
        return {"id": "rcp_fake"}

    def fail(self, *, error):
        self._ledger.fails.append(error)


class FakeHandle:
    def __init__(self, ledger: FakeLedger) -> None:
        self._ledger = ledger
        self.data = {
            "id": ledger.task_id,
            "state": ledger.state,
            "payloadHash": "hmac-sha256:" + "ab" * 32,
            "decision": {},
        }
        self.degraded = False

    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def state(self) -> str:
        return self.data["state"]

    @property
    def decision(self) -> dict:
        return self.data["decision"]

    def claim(self) -> FakeRun:
        return FakeRun(self._ledger)


class FakeLedger:
    def __init__(self, state: str = "pending_approval") -> None:
        self.state = state
        self.approved = {"action": "email.send", "args": {"to": ["ok@example.com"], "subject": "周会"}}
        self.task_id = "tsk_fake"
        self.dir = "/tmp/actledger-fake"
        self.strict_content = True
        self.gets = 0
        self.completes: list[dict] = []
        self.fails: list[dict] = []

    def request(self, **kwargs):
        self.requested = kwargs
        return FakeHandle(self)

    def get_task(self, task_id: str):
        self.gets += 1
        return FakeHandle(self)


def _gate(ledger, interrupt_fn, calls: list):
    @ledger_gate(
        ledger,
        action="email.send",
        principal=lambda state: "u_1",
        payload=lambda state: {"action": "email.send", "args": {"to": ["a@example.com"]}},
        interrupt_fn=interrupt_fn,
    )
    def send(state, ctx):
        calls.append({"payload": ctx.approved_payload, "resume": ctx.resume_value})
        return {"sent": True}

    return send


def test_fake_resume_uses_ledger_payload_not_the_interrupt_value() -> None:
    ledger = FakeLedger()
    calls: list[dict] = []

    def interrupt_fn(value):
        ledger.state = "approved"
        return {"payload": {"action": "email.send", "args": {"to": ["evil@x.com"]}}}

    _gate(ledger, interrupt_fn, calls)({})
    assert calls == [{"payload": ledger.approved, "resume": {"payload": {"action": "email.send", "args": {"to": ["evil@x.com"]}}}}]
    assert ledger.gets == 2
    assert ledger.completes[0]["payload"] == ledger.approved


def test_fake_resume_without_approval_suspends_again() -> None:
    ledger = FakeLedger()
    calls: list[dict] = []
    seen = {"n": 0}

    def interrupt_fn(value):
        seen["n"] += 1
        if seen["n"] == 2:
            raise Suspend()
        return {"approved": True}

    with pytest.raises(Suspend):
        _gate(ledger, interrupt_fn, calls)({})
    assert calls == []
    assert seen["n"] == 2


def test_executing_task_is_not_rerun() -> None:
    ledger = FakeLedger(state="executing")
    calls: list[dict] = []
    with pytest.raises(LedgerError) as error:
        _gate(ledger, lambda value: {"approved": True}, calls)({})
    assert error.value.code == "invalid_transition"
    assert calls == []


@pytest.mark.node
def test_injected_interrupt_approves_through_the_cli(tmp_path: Path, init_dir, cli) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    edit = Path(__file__).parent / "fixtures" / "edited-email.json"
    edited = json.loads(edit.read_text(encoding="utf-8"))
    calls: list[dict] = []
    with __import__("actledger").Ledger(dir=ledger_dir) as ledger:

        def interrupt_fn(value):
            result = cli(["approve", value["actledger_task_id"], "--dir", str(ledger_dir), "--edit", str(edit)])
            assert result.returncode == 0, result.stderr
            return {"payload": {"action": "email.send", "args": {"to": ["evil@x.com"]}}}

        @ledger_gate(
            ledger,
            action="email.send",
            principal=lambda state: state["user_id"],
            payload=lambda state: {
                "action": "email.send",
                "args": {"to": ["a@example.com"], "subject": "周会"},
                "content": {"content_type": "text/plain", "text": "回复邮件：周会 😀"},
                "allowed_drift": ["args.signature"],
            },
            interrupt_fn=interrupt_fn,
        )
        def send(state, ctx):
            calls.append(ctx.approved_payload)
            return {"sent": True}

        send({"user_id": "u_1"})
    assert calls == [edited]
