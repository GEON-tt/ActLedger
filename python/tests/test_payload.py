from __future__ import annotations

import json

import pytest

from actledger.errors import LedgerError
from actledger.payload import compare_with_drift, normalize_payload


def test_drift_match_and_mismatch() -> None:
    approved = {
        "action": "email.send",
        "args": {"to": "bob", "signature": "old"},
        "allowed_drift": ["args.signature"],
    }
    executed = {
        "action": "email.send",
        "args": {"to": "bob", "signature": "new"},
    }
    compared = compare_with_drift(approved, executed)
    assert compared.match is True
    assert compared.drift_applied == ["args.signature"]
    changed = {"action": "email.send", "args": {"to": "ada", "signature": "new"}}
    mismatch = compare_with_drift(approved, changed)
    assert mismatch.match is False
    assert mismatch.drift_applied == ["args.signature"]


def test_invalid_drift_paths() -> None:
    with pytest.raises(LedgerError) as error:
        compare_with_drift({"action": "a", "args": {}, "allowed_drift": ["__proto__.x"]}, {"action": "a", "args": {}})
    assert error.value.message == "invalid drift path __proto__.x"
    with pytest.raises(LedgerError) as missing:
        normalize_payload({"args": {}})
    assert missing.value.message == "payload.action is required"
    with pytest.raises(LedgerError) as args:
        normalize_payload({"action": "a", "args": []})
    assert args.value.message == "payload.args must be an object"


@pytest.mark.node
def test_array_drift_matches_node(parity) -> None:
    cases = [
        (
            "index",
            {"action": "a", "args": {"to": ["a", "b"]}, "allowed_drift": ["args.to.0"]},
            {"action": "a", "args": {"to": ["z", "b"]}},
        ),
        (
            "hole",
            {"action": "a", "args": {"to": ["a", "b"]}, "allowed_drift": ["args.to.2"]},
            {"action": "a", "args": {"to": ["a", "b", "c"]}},
        ),
    ]
    batch = {
        "drift": [
            {"name": name, "approved": json.dumps(approved), "executed": json.dumps(executed)}
            for name, approved, executed in cases
        ]
    }
    result = parity(batch)
    for (name, approved, executed), remote in zip(cases, result["drift"]):
        local = compare_with_drift(approved, executed)
        if remote.get("error", {}).get("code") == "throw":
            pytest.skip(f"{name}: {remote['error']['message']}")
        assert remote["match"] is local.match
        assert remote["driftApplied"] == local.drift_applied
