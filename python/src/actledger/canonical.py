from __future__ import annotations

import hashlib
import hmac
import json
import math

from .errors import LedgerError

MAX_SAFE = 2**53 - 1
GENESIS_HASH = "sha256:" + "0" * 64


class _Hole:
    pass


HOLE = _Hole()


def _quote(text: str) -> str:
    parts = ['"']
    index = 0
    size = len(text)
    while index < size:
        code = ord(text[index])
        if 0xD800 <= code <= 0xDBFF and index + 1 < size:
            nxt = ord(text[index + 1])
            if 0xDC00 <= nxt <= 0xDFFF:
                parts.append(chr(0x10000 + ((code - 0xD800) << 10) + (nxt - 0xDC00)))
                index += 2
                continue
        if code == 0x22:
            parts.append('\\"')
        elif code == 0x5C:
            parts.append("\\\\")
        elif code == 0x08:
            parts.append("\\b")
        elif code == 0x0C:
            parts.append("\\f")
        elif code == 0x0A:
            parts.append("\\n")
        elif code == 0x0D:
            parts.append("\\r")
        elif code == 0x09:
            parts.append("\\t")
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            parts.append(f"\\u{code:04x}")
        else:
            parts.append(text[index])
        index += 1
    parts.append('"')
    return "".join(parts)


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def _non_canonical(path: str) -> LedgerError:
    return LedgerError("non_canonical_number", f"{path} is not a safe integer", 400)


def _not_serializable(path: str) -> LedgerError:
    return LedgerError("invalid_request", f"{path} is not JSON-serializable", 400)


def jcs(value: object) -> str:
    return _serialize(value, "$")


def _serialize(value: object, path: str) -> str:
    if value is HOLE:
        return ""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE:
            raise _non_canonical(path)
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise _non_canonical(path)
        integer = int(value)
        if abs(integer) > MAX_SAFE:
            raise _non_canonical(path)
        return str(integer)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_serialize(item, f"{path}[{index}]") for index, item in enumerate(value)) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise _not_serializable(path)
        parts: list[str] = []
        for key in sorted(value, key=_utf16_key):
            parts.append(f"{_quote(key)}:{_serialize(value[key], f'{path}.{key}')}")
        return "{" + ",".join(parts) + "}"
    raise _not_serializable(path)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_prefixed(text: str) -> str:
    return f"sha256:{sha256_hex(text)}"


def commit(salt: bytes, value: object) -> str:
    mac = hmac.new(salt, jcs(value).encode("utf-8"), hashlib.sha256).hexdigest()
    return f"hmac-sha256:{mac}"


def _reject_constant(constant: str) -> object:
    raise LedgerError("invalid_request", f"{constant} is not allowed", 400)


def _parse_float(text: str) -> object:
    value = float(text)
    if math.isfinite(value) and value.is_integer():
        integer = int(value)
        if abs(integer) <= MAX_SAFE:
            return integer
    return value


def loads_strict(text: str) -> object:
    return json.loads(text, parse_constant=_reject_constant, parse_float=_parse_float)


def is_safe_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and abs(value) <= MAX_SAFE
