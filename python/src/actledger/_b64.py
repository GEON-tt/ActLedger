from __future__ import annotations

# Node Buffer.from(text, "base64url") never throws. Invalid characters are
# skipped, "+" and "/" are accepted, "=" ends the input, and leftover bits
# that do not fill a byte are dropped.

_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_VALUES = {char: index for index, char in enumerate(_ALPHABET)}
_VALUES["+"] = 62
_VALUES["/"] = 63


def b64url_decode_lenient(text: str) -> bytes:
    acc = 0
    nbits = 0
    out = bytearray()
    for char in text:
        if char == "=":
            break
        value = _VALUES.get(char)
        if value is None:
            continue
        acc = (acc << 6) | value
        nbits += 6
        if nbits >= 8:
            nbits -= 8
            out.append((acc >> nbits) & 0xFF)
    return bytes(out)


def b64url_encode(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")
