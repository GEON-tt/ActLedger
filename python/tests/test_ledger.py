from __future__ import annotations

import signal
import threading
from pathlib import Path

import pytest

from actledger import (
    ApprovalExpired,
    ApprovalRejected,
    ApprovalRevoked,
    Ledger,
    LedgerError,
    LedgerUnavailable,
)


def _email(ledger: Ledger, **extra):
    return ledger.request(
        principal_id="u_1",
        action={"type": "email.send"},
        payload={
            "action": "email.send",
            "args": {"to": ["a@example.com"], "subject": "周会"},
            "content": {"content_type": "text/plain", "text": "回复邮件：周会 😀"},
        },
        intent="回复邮件：周会",
        **extra,
    )


def _calendar(ledger: Ledger, **extra):
    return ledger.request(
        principal_id="u_1",
        action={"type": "calendar.create"},
        payload={"action": "calendar.create", "args": {"title": "standup"}},
        **extra,
    )


@pytest.mark.node
def test_request_roundtrip_and_idempotency(tmp_path: Path, init_dir) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    with Ledger(dir=ledger_dir) as ledger:
        created = _email(ledger, idempotency_key="same")
        again = _email(ledger, idempotency_key="same")
        assert created.id == again.id
        fetched = ledger.get_task(created.id)
        assert fetched is not None
        assert fetched.data["payloadHash"].startswith("hmac-sha256:")


@pytest.mark.node
def test_wait_timeout_revoke_and_reject(tmp_path: Path, init_dir, cli) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    with Ledger(dir=ledger_dir) as ledger:
        pending = _email(ledger)
        with pytest.raises(ApprovalExpired) as expired:
            pending.wait(timeout=0.3)
        assert str(expired.value) == "wait timed out"

        revoked = _email(ledger)
        ledger.revoke(revoked.id)
        with pytest.raises(ApprovalRevoked):
            revoked.wait(timeout=5)

        rejected = _email(ledger)

        def reject() -> None:
            result = cli(["reject", rejected.id, "--dir", str(ledger_dir), "--note", "不发"])
            assert result.returncode == 0, result.stderr

        threading.Thread(target=reject).start()
        with pytest.raises(ApprovalRejected):
            rejected.wait(timeout=10)


@pytest.mark.node
def test_claim_is_single_use(tmp_path: Path, init_dir) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    with Ledger(dir=ledger_dir) as ledger:
        task = _calendar(ledger)
        assert task.state == "approved"
        task.claim()
        with pytest.raises(LedgerError) as error:
            task.claim()
        assert error.value.code == "already_claimed"
        assert error.value.status == 409


@pytest.mark.node
def test_killed_process_and_degraded_read(tmp_path: Path, init_dir) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    ledger = Ledger(dir=ledger_dir)
    import os

    os.kill(ledger._rpc.proc.pid, signal.SIGKILL)
    ledger._rpc.proc.wait(timeout=5)
    with pytest.raises(LedgerUnavailable):
        _email(ledger)
    ledger.close()
    ledger.close()

    relaxed = Ledger(dir=ledger_dir, on_unavailable="allow_read_only")
    os.kill(relaxed._rpc.proc.pid, signal.SIGKILL)
    relaxed._rpc.proc.wait(timeout=5)
    degraded = relaxed.request(
        principal_id="u_1",
        action={"type": "email.read"},
        payload={"action": "email.read", "args": {}},
        read_only=True,
    )
    assert degraded.degraded is True
    assert degraded.id == "tsk_degraded"
    with pytest.raises(LedgerUnavailable, match="degraded read-only task cannot be claimed"):
        degraded.claim()
    relaxed.close()


@pytest.mark.node
def test_close_is_idempotent_and_missing_command_fails(tmp_path: Path, init_dir) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    ledger = Ledger(dir=ledger_dir)
    ledger.close()
    assert ledger._rpc.proc.poll() is not None
    ledger.close()
    with pytest.raises(LedgerUnavailable):
        Ledger(dir=ledger_dir, command=["/nonexistent-actledger"])
