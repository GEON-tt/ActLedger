from __future__ import annotations

import re

from .canonical import commit, loads_strict
from .errors import LedgerError
from .payload import normalize_payload

RECEIPT_V01 = "actledger.receipt/0.1"
RECEIPT_V02 = "actledger.receipt/0.2"
SECRETS_V = "actledger.secrets/0.1"
ERROR_CODE_RE = re.compile(r"^[a-z0-9_.]{1,64}$")
COMMIT_RE = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
SHA_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

REASONS = {
    "rejected": ("rejected_by_user", "denied_by_policy"),
    "drafted": ("draft_only",),
    "expired": ("approval_timeout", "claim_deadline"),
    "unknown": ("execution_timeout",),
    "revoked": ("revoked",),
    "failed": ("reconciled_not_executed",),
}


def reason_allowed(to: str, reason: str) -> bool:
    allowed = REASONS.get(to)
    return allowed is not None and reason in allowed


def payload_commit(salt: bytes, payload: object) -> str:
    return commit(salt, normalize_payload(payload))


def text_commit(salt: bytes, value: str) -> str:
    return commit(salt, value)


def parse_secrets_jsonl(text: str) -> list[dict]:
    entries: list[dict] = []
    for line in text.split("\n"):
        trimmed = line.strip()
        if not trimmed:
            continue
        value = loads_strict(trimmed)
        if not isinstance(value, dict) or value.get("v") != SECRETS_V or value.get("kind") not in ("task", "violation"):
            raise LedgerError("invalid_request", "invalid secrets entry", 400)
        entries.append(value)
    return entries
