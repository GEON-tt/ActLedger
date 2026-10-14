from __future__ import annotations

from pathlib import Path

import pytest

from actledger import Ledger, LedgerError


def _email(ledger: Ledger, **extra):
    return ledger.request(
        principal_id="u_1",
        action={"type": "email.send"},
        payload={"action": "email.send", "args": {"to": ["a@example.com"], "subject": "周会"}},
        intent="回复邮件：周会",
        **extra,
    )


@pytest.mark.node
def test_missing_directory_and_hello(tmp_path: Path, init_dir) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(LedgerError) as missing:
        Ledger(dir=empty)
    assert missing.value.code == "not_found"

    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    with Ledger(dir=ledger_dir) as ledger:
        hello = ledger._rpc.call("hello", {})
        assert hello["protocol"] == "actledger.rpc/1"
        created = _email(ledger)
        assert created.state == "pending_approval"
        fetched = ledger.get_task(created.id)
        assert fetched is not None and fetched.id == created.id


@pytest.mark.node
def test_unknown_method_then_stdin_eof(tmp_path: Path, init_dir) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    ledger = Ledger(dir=ledger_dir)
    with pytest.raises(LedgerError) as error:
        ledger._rpc.call("no_such_method", {})
    assert error.value.code == "method_not_found"
    assert ledger._rpc.proc.stdin is not None
    ledger._rpc.proc.stdin.close()
    assert ledger._rpc.proc.wait(timeout=15) == 0
