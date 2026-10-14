from __future__ import annotations

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ._b64 import b64url_decode_lenient


def verify_ed25519(public_key_b64url: str, message: str, sig_b64url: str) -> bool:
    try:
        raw = b64url_decode_lenient(public_key_b64url)
        if len(raw) != 32:
            return False
        Ed25519PublicKey.from_public_bytes(raw).verify(b64url_decode_lenient(sig_b64url), message.encode("utf-8"))
        return True
    except Exception:
        return False
