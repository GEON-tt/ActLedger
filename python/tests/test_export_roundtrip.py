from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from actledger import ApprovalRejected, ContentMismatch, Ledger
from actledger.secrets import parse_secrets_jsonl
from actledger.verify import verify_jsonl


def _email() -> dict:
    return {
        "action": "email.send",
        "args": {"to": ["a@example.com"], "subject": "周会"},
        "content": {"content_type": "text/plain", "text": "回复邮件：周会 😀"},
        "allowed_drift": ["args.signature"],
    }


def _approve(cli, directory: Path, task_id: str, edit: Path | None = None) -> None:
    args = ["approve", task_id, "--dir", str(directory)]
    if edit is not None:
        args.extend(["--edit", str(edit)])
    result = cli(args)
    assert result.returncode == 0, result.stderr


@pytest.mark.node
def test_export_roundtrip(tmp_path: Path, init_dir, cli, parity) -> None:
    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    edit = Path(__file__).parent / "fixtures" / "edited-email.json"
    edited = json.loads(edit.read_text(encoding="utf-8"))
    with Ledger(dir=ledger_dir) as ledger:
        created = ledger.request(
            principal_id="u_1",
            action={"type": "calendar.create"},
            payload={"action": "calendar.create", "args": {"title": "standup"}},
        )
        created.wait(timeout=5).claim().complete(executed_payload={"action": "calendar.create", "args": {"title": "standup"}})

        pending = ledger.request(
            principal_id="u_1",
            action={"type": "email.send"},
            payload=_email(),
            intent="回复邮件：周会",
        )
        assert pending.state == "pending_approval"

        def approve() -> None:
            _approve(cli, ledger_dir, pending.id, edit)

        approver = threading.Thread(target=approve)
        approver.start()
        ready = pending.wait(timeout=20)
        approver.join()
        ready.claim().complete(
            executed_payload=edited,
            external_proofs=[{"type": "email_msgid", "value": "<id@mail>"}],
        )

        rejected = ledger.request(
            principal_id="u_1",
            action={"type": "email.send"},
            payload=_email(),
            intent="回复邮件：周会",
        )

        def reject() -> None:
            result = cli(["reject", rejected.id, "--dir", str(ledger_dir), "--note", "不发"])
            assert result.returncode == 0, result.stderr

        rejector = threading.Thread(target=reject)
        rejector.start()
        with pytest.raises(ApprovalRejected):
            rejected.wait(timeout=20)
        rejector.join()

        failed = ledger.request(
            principal_id="u_1",
            action={"type": "email.send"},
            payload=_email(),
            intent="回复邮件：周会",
        )

        def approve_failed() -> None:
            _approve(cli, ledger_dir, failed.id)

        failed_approver = threading.Thread(target=approve_failed)
        failed_approver.start()
        run = failed.wait(timeout=20).claim()
        failed_approver.join()
        run.fail(error={"code": "smtp.timeout", "message": "超时"})

        mismatched = ledger.request(
            principal_id="u_1",
            action={"type": "email.send"},
            payload=_email(),
            intent="回复邮件：周会",
        )

        def approve_mismatch() -> None:
            _approve(cli, ledger_dir, mismatched.id)

        mismatch_approver = threading.Thread(target=approve_mismatch)
        mismatch_approver.start()
        claimed = mismatched.wait(timeout=20).claim()
        mismatch_approver.join()
        changed = json.loads(json.dumps(claimed.approved_payload))
        changed["args"]["subject"] = "被篡改"
        with pytest.raises(ContentMismatch):
            claimed.complete(executed_payload=changed)
        stored = ledger.get_task(mismatched.id)
        assert stored is not None
        assert stored.state == "failed"
        assert stored.data["error"]["code"] == "content_mismatch"

    secrets_path = tmp_path / "secrets.jsonl"
    exported = cli(["export", "--dir", str(ledger_dir), "--secrets", str(secrets_path)])
    assert exported.returncode == 0, exported.stderr
    receipts_path = tmp_path / "receipts.jsonl"
    receipts_path.write_text(exported.stdout, encoding="utf-8")
    keys = json.loads((ledger_dir / "keys.json").read_text(encoding="utf-8"))
    secrets_text = secrets_path.read_text(encoding="utf-8")
    report = verify_jsonl(exported.stdout, keys, secrets=parse_secrets_jsonl(secrets_text))
    assert report.ok is True
    assert report.stats["count"] == len([line for line in exported.stdout.split("\n") if line.strip()])
    assert set(report.stats["byVersion"]) == {"actledger.receipt/0.2"}
    assert report.stats["secrets"]["checked"] >= 5

    import subprocess
    import sys

    verified = subprocess.run(
        [sys.executable, "-m", "actledger", "verify", str(receipts_path), "--keys", str(ledger_dir / "keys.json"), "--secrets", str(secrets_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert verified.returncode == 0, verified.stderr
    assert verified.stdout.startswith("OK ")

    remote = parity(
        {
            "verify": [
                {
                    "name": "export",
                    "receipts": exported.stdout,
                    "keys": (ledger_dir / "keys.json").read_text(encoding="utf-8"),
                    "secrets": secrets_text,
                }
            ]
        }
    )["verify"][0]
    assert report.to_dict() == remote["report"]

    tampered = []
    for line in secrets_text.split("\n"):
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("kind") == "task" and isinstance(entry.get("intent"), str) and "周会" in entry["intent"]:
            entry["intent"] = entry["intent"].replace("周会", "周会X", 1)
        tampered.append(entry)
    tampered_text = "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in tampered)
    py_bad = verify_jsonl(exported.stdout, keys, secrets=parse_secrets_jsonl(tampered_text))
    ts_bad = parity(
        {
            "verify": [
                {
                    "name": "tampered-intent",
                    "receipts": exported.stdout,
                    "keys": (ledger_dir / "keys.json").read_text(encoding="utf-8"),
                    "secrets": tampered_text,
                }
            ]
        }
    )["verify"][0]
    assert py_bad.ok is False
    assert py_bad.failure["step"] == "secrets"
    assert py_bad.to_dict() == ts_bad["report"]
