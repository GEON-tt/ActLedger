from __future__ import annotations

import copy

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from actledger._b64 import b64url_encode
from actledger.canonical import GENESIS_HASH
from actledger.receipts import receipt_hash, unsigned_receipt


def make_keypair() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private, b64url_encode(public)


def sign_hash(private: Ed25519PrivateKey, digest: str) -> str:
    return b64url_encode(private.sign(digest.encode("utf-8")))


def with_public_key(keys: dict, public_b64: str) -> dict:
    cloned = copy.deepcopy(keys)
    for key in cloned["keys"]:
        key["public_key"] = public_b64
    return cloned


def rechain(receipts: list[dict], private: Ed25519PrivateKey) -> list[dict]:
    ordered = sorted((copy.deepcopy(receipt) for receipt in receipts), key=lambda receipt: receipt["seq"])
    previous = GENESIS_HASH
    out: list[dict] = []
    for index, receipt in enumerate(ordered):
        receipt["seq"] = index + 1
        receipt["prev_hash"] = previous
        digest = receipt_hash(unsigned_receipt(receipt))
        receipt["hash"] = digest
        receipt["sig"] = {
            "alg": "Ed25519",
            "kid": receipt["sig"]["kid"],
            "value": sign_hash(private, digest),
        }
        previous = digest
        out.append(receipt)
    return out
