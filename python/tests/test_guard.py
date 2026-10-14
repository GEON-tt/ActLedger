from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from actledger import ApprovalRejected, ContentMismatch, Ledger


def _edited() -> dict:
    return json.loads((Path(__file__).parent / "fixtures" / "edited-email.json").read_text(encoding="utf-8"))


def _approve_pending(cli, directory: Path, edit: Path | None = None) -> None:
    import time

    deadline = time.time() + 20
    while time.time() < deadline:
        listed = cli(["tasks", "--dir", str(directory), "--state", "pending_approval", "--json"])
        assert listed.returncode == 0, listed.stderr
        tasks = json.loads(listed.stdout) if listed.stdout.strip() else []
        if tasks:
            args = ["approve", tasks[0]["id"], "--dir", str(directory)]
            if edit is not None:
                args.extend(["--edit", str(edit)])
            approved = cli(args)
            assert approved.returncode == 0, approved.stderr
            return
        time.sleep(0.05)
    raise AssertionError("no pending task")


@pytest.mark.node
def test_guard_allows_calendar_and_edited_email(tmp_path: Path, init_dir, cli) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    payload = {"action": "calendar.create", "args": {"title": "standup"}}
    seen: list[dict] = []
    with Ledger(dir=ledger_dir) as ledger:

        @ledger.guard(
            action="calendar.create",
            principal=lambda kw: "u_1",
            payload=lambda kw: payload,
        )
        def create(*, ctx):
            seen.append(ctx.approved_payload)
            return ctx.task_id

        task_id = create()
        assert seen == [payload]
        assert ledger.get_task(task_id).state == "executed"

        calls = {"n": 0}
        requested = {
            "action": "email.send",
            "args": {"to": ["a@example.com"], "subject": "周会"},
            "content": {"content_type": "text/plain", "text": "回复邮件：周会 😀"},
            "allowed_drift": ["args.signature"],
        }

        @ledger.guard(
            action="email.send",
            principal=lambda kw: "u_1",
            payload=lambda kw: requested,
            intent=lambda kw: "回复邮件：周会",
        )
        def send(*, ctx):
            calls["n"] += 1
            calls["payload"] = ctx.approved_payload
            calls["id"] = ctx.task_id
            return "sent"

        edit = Path(__file__).parent / "fixtures" / "edited-email.json"
        worker = threading.Thread(target=_approve_pending, args=(cli, ledger_dir, edit))
        worker.start()
        assert send() == "sent"
        worker.join()
        assert calls["n"] == 1
        assert calls["payload"] == _edited()
        assert ledger.get_task(calls["id"]).state == "executed"


@pytest.mark.node
def test_guard_checks_content_before_calling_and_stops_on_reject(tmp_path: Path, init_dir, cli) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    requested = {
        "action": "email.send",
        "args": {"to": ["a@example.com"], "subject": "周会"},
        "content": {"content_type": "text/plain", "text": "回复邮件：周会 😀"},
        "allowed_drift": ["args.signature"],
    }
    calls = {"n": 0}
    with Ledger(dir=ledger_dir) as ledger:

        def changed(kw, approved):
            payload = json.loads(json.dumps(approved))
            payload["args"]["subject"] = "被篡改"
            return payload

        @ledger.guard(
            action="email.send",
            principal=lambda kw: "u_1",
            payload=lambda kw: requested,
            executed_payload=changed,
        )
        def send(*, ctx):
            calls["n"] += 1

        edit = Path(__file__).parent / "fixtures" / "edited-email.json"
        worker = threading.Thread(target=_approve_pending, args=(cli, ledger_dir, edit))
        worker.start()
        with pytest.raises(ContentMismatch):
            send()
        worker.join()
        assert calls["n"] == 0
        tasks = json.loads(cli(["tasks", "--dir", str(ledger_dir), "--json"]).stdout)
        failed = [task for task in tasks if task["state"] == "failed"]
        assert failed[-1]["error"]["code"] == "content_mismatch"

        @ledger.guard(
            action="email.send",
            principal=lambda kw: "u_1",
            payload=lambda kw: requested,
        )
        def rejected(*, ctx):
            calls["n"] += 1

        def reject_pending() -> None:
            import time

            deadline = time.time() + 20
            while time.time() < deadline:
                listed = cli(["tasks", "--dir", str(ledger_dir), "--state", "pending_approval", "--json"])
                pending = json.loads(listed.stdout) if listed.stdout.strip() else []
                if pending:
                    result = cli(["reject", pending[0]["id"], "--dir", str(ledger_dir), "--note", "不发"])
                    assert result.returncode == 0, result.stderr
                    return
                time.sleep(0.05)
            raise AssertionError("no pending task")

        worker = threading.Thread(target=reject_pending)
        worker.start()
        with pytest.raises(ApprovalRejected):
            rejected()
        worker.join()
        assert calls["n"] == 0
