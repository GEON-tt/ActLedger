from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from actledger.errors import LedgerError
from actledger.secrets import parse_secrets_jsonl
from actledger.verify import STEPS, verify_jsonl

from _mutate import make_keypair, rechain, with_public_key


def _loads(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _dumps(receipts: list[dict]) -> str:
    return "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in receipts)


def _secrets(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _alt_hash(prefix: str = "ab") -> str:
    return "hmac-sha256:" + prefix * 32


@pytest.mark.node
def test_verify_parity(parity, vectors: Path) -> None:
    chain = (vectors / "receipts-chain-0.2.jsonl").read_text(encoding="utf-8")
    legacy = (vectors / "receipts-chain-0.1.jsonl").read_text(encoding="utf-8")
    keys_text = (vectors / "keys.json").read_text(encoding="utf-8")
    secrets_text = (vectors / "secrets-0.2.jsonl").read_text(encoding="utf-8")
    keys = json.loads(keys_text)
    private, public = make_keypair()
    resigned_keys = json.dumps(with_public_key(keys, public))

    def resign(receipts: list[dict]) -> str:
        return _dumps(rechain(receipts, private))

    base_receipts = _loads(chain)
    tamper_body = copy.deepcopy(base_receipts)
    tamper_body[0]["body"]["tampered"] = True
    tamper_hash = copy.deepcopy(base_receipts)
    digest = tamper_hash[0]["hash"]
    tamper_hash[0]["hash"] = digest[:-1] + ("0" if digest[-1] != "0" else "1")
    tamper_sig = copy.deepcopy(base_receipts)
    sig = tamper_sig[0]["sig"]["value"]
    tamper_sig[0]["sig"]["value"] = ("A" if not sig.startswith("A") else "B") + sig[1:]
    tamper_kid = copy.deepcopy(base_receipts)
    tamper_kid[0]["sig"]["kid"] = "missing-kid"
    retired = copy.deepcopy(keys)
    retired["keys"][0]["retired_at"] = "2000-01-01T00:00:00.000Z"
    gap = copy.deepcopy(base_receipts)
    del gap[len(gap) // 2]
    dropped = [item for item in base_receipts if item["seq"] != 1]
    shuffled = list(reversed(base_receipts))
    spaced = "\n" + "  " + chain.split("\n", 1)[0] + "  \n\n" + chain.split("\n", 1)[1]
    floated = copy.deepcopy(base_receipts)
    floated[0]["body"]["note"] = 1.5
    noted = copy.deepcopy(base_receipts)
    noted[0]["body"]["note"] = "hello"
    reasoned = copy.deepcopy(base_receipts)
    reason_body = reasoned[0]["body"]
    for field in ("note", "description", "result"):
        reason_body.pop(field, None)
    initiator = reason_body.get("initiator")
    if isinstance(initiator, dict):
        initiator.pop("intent", None)
    approval = reason_body.get("approval")
    if isinstance(approval, dict):
        approval.pop("note", None)
    reason_body["reason"] = "not_a_reason"
    errored = copy.deepcopy(base_receipts)
    found_error = False
    for receipt in errored:
        error = receipt["body"].get("error")
        if isinstance(error, dict):
            error["detail"] = "x"
            found_error = True
            break
    assert found_error
    changed_hash = copy.deepcopy(base_receipts)
    seen_hash: set[str] = set()
    changed = False
    for receipt in changed_hash:
        task_id = receipt.get("task_id")
        if not isinstance(task_id, str) or not isinstance(receipt["body"].get("payload_hash"), str):
            continue
        if task_id in seen_hash:
            receipt["body"]["payload_hash"] = _alt_hash()
            changed = True
            break
        seen_hash.add(task_id)
    assert changed
    changed_approved = copy.deepcopy(base_receipts)
    approved_changed = False
    for receipt in changed_approved:
        if (receipt.get("transition") or {}).get("to") == "executed":
            receipt["body"]["approved_payload_hash"] = _alt_hash("cd")
            approved_changed = True
            break
    assert approved_changed
    missing_claim = copy.deepcopy(base_receipts)
    removed = False
    for index, receipt in enumerate(missing_claim):
        transition = receipt.get("transition") or {}
        if transition.get("from") == "approved" and transition.get("to") == "executing":
            del missing_claim[index]
            removed = True
            break
    assert removed
    unmarked = copy.deepcopy(base_receipts)
    unmarked_found = False
    for receipt in unmarked:
        body = receipt["body"]
        if (receipt.get("transition") or {}).get("to") != "executed":
            continue
        if body.get("executed_hash") != body.get("approved_payload_hash"):
            body.pop("content_match", None)
            body.pop("mismatch", None)
            unmarked_found = True
            break
    assert unmarked_found
    mixed = copy.deepcopy(base_receipts)
    seen_task: set[str] = set()
    mixed_found = False
    for receipt in mixed:
        task_id = receipt.get("task_id")
        if not isinstance(task_id, str):
            continue
        if task_id in seen_task:
            receipt["v"] = "actledger.receipt/0.1"
            mixed_found = True
            break
        seen_task.add(task_id)
    assert mixed_found

    secret_rows = _secrets(secrets_text)
    executed = copy.deepcopy(secret_rows)
    for entry in executed:
        payload = entry.get("executed_payload")
        if entry.get("kind") == "task" and isinstance(payload, dict) and not entry.get("shredded"):
            args = payload.get("args")
            if isinstance(args, dict):
                if isinstance(args.get("title"), str):
                    args["title"] += "x"
                elif isinstance(args.get("subject"), str):
                    args["subject"] += "x"
            break
    intent = copy.deepcopy(secret_rows)
    for entry in intent:
        if entry.get("kind") == "task" and isinstance(entry.get("intent"), str) and not entry.get("shredded"):
            entry["intent"] += "x"
            break
    deleted = [entry for index, entry in enumerate(secret_rows) if not (index == 0 and entry.get("kind") == "task")]
    shredded = copy.deepcopy(secret_rows)
    for entry in shredded:
        if entry.get("kind") == "task" and not entry.get("shredded"):
            entry["shredded"] = True
            break
    described = copy.deepcopy(secret_rows)
    for entry in described:
        if entry.get("kind") == "violation":
            entry["description"] += "x"
            break
    proof = copy.deepcopy(secret_rows)
    for entry in proof:
        proofs = entry.get("proofs")
        if entry.get("kind") == "task" and isinstance(proofs, list) and proofs:
            proofs[0]["value"] = "changed"
            break

    cases = [
        ("v01", legacy, keys_text, None, "ok"),
        ("v02", chain, keys_text, None, "ok"),
        ("v02-secrets", chain, keys_text, secrets_text, "ok"),
        ("body", _dumps(tamper_body), keys_text, None, "hash"),
        ("hash", _dumps(tamper_hash), keys_text, None, "hash"),
        ("sig", _dumps(tamper_sig), keys_text, None, "signature"),
        ("kid", _dumps(tamper_kid), keys_text, None, "signature"),
        ("retired", legacy, json.dumps(retired), None, "signature"),
        ("gap", _dumps(gap), keys_text, None, "chain"),
        ("start", _dumps(dropped), keys_text, None, "chain"),
        ("shuffle", _dumps(shuffled), keys_text, None, "ok"),
        ("blank", spaced, keys_text, None, "ok"),
        ("float", _dumps(floated), keys_text, None, "error"),
        ("note", resign(noted), resigned_keys, None, "plaintext"),
        ("reason", resign(reasoned), resigned_keys, None, "plaintext"),
        ("error-field", resign(errored), resigned_keys, None, "plaintext"),
        ("payload-hash", resign(changed_hash), resigned_keys, None, "commitments"),
        ("approved-hash", resign(changed_approved), resigned_keys, None, "commitments"),
        ("missing-claim", resign(missing_claim), resigned_keys, None, "state_machine"),
        ("unmarked", resign(unmarked), resigned_keys, None, "semantics"),
        ("version", resign(mixed), resigned_keys, None, "version"),
        ("executed", chain, keys_text, _dumps(executed), "secrets"),
        ("intent", chain, keys_text, _dumps(intent), "secrets"),
        ("missing-secret", chain, keys_text, _dumps(deleted), "ok"),
        ("shredded", chain, keys_text, _dumps(shredded), "ok"),
        ("description", chain, keys_text, _dumps(described), "secrets"),
        ("proof", chain, keys_text, _dumps(proof), "secrets"),
    ]
    assert len(cases) == 27
    batch = {
        "verify": [
            {"name": name, "receipts": receipts, "keys": key_text, "secrets": secrets}
            for name, receipts, key_text, secrets, _expected in cases
        ]
    }
    remote = parity(batch)["verify"]
    baseline = verify_jsonl(chain, keys, secrets=parse_secrets_jsonl(secrets_text))
    throws = []
    for (name, receipts, key_text, secrets, expected), item in zip(cases, remote):
        assert item["name"] == name
        if item.get("error", {}).get("code") == "throw":
            throws.append(f"{name}: {item['error']['message']}")
            continue
        parsed_keys = json.loads(key_text)
        parsed_secrets = None if secrets is None else parse_secrets_jsonl(secrets)
        if expected == "error":
            with pytest.raises(LedgerError) as caught:
                verify_jsonl(receipts, parsed_keys, secrets=parsed_secrets)
            assert item["error"]["code"] == caught.value.code == "non_canonical_number"
            assert item["error"]["message"] == str(caught.value)
            continue
        report = verify_jsonl(receipts, parsed_keys, secrets=parsed_secrets)
        assert report.to_dict() == item["report"]
        if expected == "ok":
            assert report.ok is True
        else:
            assert report.ok is False
            assert report.failure["step"] == expected
            assert report.failure["step"] in STEPS
        if name == "v01":
            assert report.stats["count"] == 5
            assert report.warnings[0]["code"] == "v01_plaintext"
        if name == "v02-secrets":
            assert report.stats["secrets"]["checked"] > 0
            assert report.stats["secrets"]["shredded"] >= 1
        if name == "missing-secret":
            assert report.stats["secrets"]["missing"] == baseline.stats["secrets"]["missing"] + 1
        if name == "shredded":
            assert report.stats["secrets"]["shredded"] == baseline.stats["secrets"]["shredded"] + 1
    if throws:
        pytest.skip("; ".join(throws))
