from __future__ import annotations

from .canonical import jcs, sha256_prefixed

_UNSIGNED_FIELDS = (
    "v",
    "id",
    "app_id",
    "seq",
    "prev_hash",
    "task_id",
    "transition",
    "actor",
    "body",
    "evidence",
    "issued_at",
)


def unsigned_receipt(receipt: dict) -> dict:
    return {field: receipt[field] for field in _UNSIGNED_FIELDS}


def receipt_hash(unsigned: dict) -> str:
    return sha256_prefixed(jcs(unsigned))
