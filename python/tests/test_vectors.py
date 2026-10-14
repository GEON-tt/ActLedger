from __future__ import annotations

import json

from pathlib import Path

from actledger.secrets import parse_secrets_jsonl
from actledger.states import STATES, TRANSITIONS
from actledger.verify import verify_jsonl


def test_transitions_match_the_spec(vectors: Path) -> None:
    document = json.loads((vectors.parent / "transitions.json").read_text(encoding="utf-8"))
    assert list(TRANSITIONS) == list(STATES)
    assert {name: list(targets) for name, targets in TRANSITIONS.items()} == document


def test_committed_chains(vectors: Path) -> None:
    keys = json.loads((vectors / "keys.json").read_text(encoding="utf-8"))
    first = verify_jsonl((vectors / "receipts-chain-0.1.jsonl").read_text(encoding="utf-8"), keys)
    assert first.ok is True
    assert first.stats["count"] == 5
    assert first.warnings[0]["code"] == "v01_plaintext"
    second = verify_jsonl((vectors / "receipts-chain-0.2.jsonl").read_text(encoding="utf-8"), keys)
    assert second.ok is True
    secrets = parse_secrets_jsonl((vectors / "secrets-0.2.jsonl").read_text(encoding="utf-8"))
    checked = verify_jsonl((vectors / "receipts-chain-0.2.jsonl").read_text(encoding="utf-8"), keys, secrets=secrets)
    assert checked.ok is True
    assert checked.stats["secrets"]["checked"] > 0
    assert checked.stats["secrets"]["shredded"] >= 1
