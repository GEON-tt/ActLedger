from __future__ import annotations

from .canonical import HOLE, jcs, loads_strict, sha256_prefixed
from .errors import LedgerError

_UNSAFE_PATH = {"__proto__", "prototype", "constructor"}


def assert_safe_path(path: str) -> None:
    if not path or path.startswith(".") or path.endswith("."):
        raise LedgerError("invalid_request", f"invalid drift path {path}", 400)
    for part in path.split("."):
        if not part or part in _UNSAFE_PATH:
            raise LedgerError("invalid_request", f"invalid drift path {path}", 400)


def assert_drift_path(path: str) -> None:
    assert_safe_path(path)
    parts = path.split(".")
    if len(parts) < 2 or parts[0] not in ("args", "content"):
        raise LedgerError("invalid_request", f"invalid drift path {path}", 400)


def normalize_payload(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise LedgerError("invalid_request", "payload.action is required", 400)
    action = payload.get("action")
    if not isinstance(action, str) or action == "":
        raise LedgerError("invalid_request", "payload.action is required", 400)
    args = payload.get("args")
    if not isinstance(args, dict):
        raise LedgerError("invalid_request", "payload.args must be an object", 400)
    out: dict = {"action": action, "args": args}
    if "content" in payload:
        out["content"] = payload["content"]
    if "allowed_drift" in payload:
        drift = payload["allowed_drift"]
        if not isinstance(drift, list):
            raise LedgerError("invalid_request", "allowed_drift must be an array", 400)
        for path in drift:
            if not isinstance(path, str):
                raise LedgerError("invalid_request", "allowed_drift entries must be strings", 400)
            assert_drift_path(path)
        out["allowed_drift"] = drift
    jcs(out)
    return out


def payload_hash(payload: object) -> str:
    return sha256_prefixed(jcs(normalize_payload(payload)))


class DriftComparison:
    def __init__(self, match: bool, drift_applied: list[str]) -> None:
        self.match = match
        self.drift_applied = drift_applied


def _array_index(part: str) -> int | None:
    if not part.isascii() or not part.isdigit():
        return None
    if len(part) > 1 and part.startswith("0"):
        return None
    value = int(part)
    if value >= 2**32 - 1:
        return None
    return value


def _lookup(root: object, path: str) -> tuple[bool, object]:
    current = root
    for part in path.split("."):
        if current is None or current is HOLE or not isinstance(current, (dict, list)):
            return False, None
        if isinstance(current, dict):
            if part not in current:
                return False, None
            current = current[part]
            if current is HOLE:
                return False, None
            continue
        if part == "length":
            current = len(current)
            continue
        index = _array_index(part)
        if index is None or index >= len(current):
            return False, None
        current = current[index]
        if current is HOLE:
            return False, None
    return True, current


def _same_found(left: tuple[bool, object], right: tuple[bool, object]) -> bool:
    if left[0] != right[0]:
        return False
    if not left[0]:
        return True
    return jcs(left[1]) == jcs(right[1])


def _child(current: object, part: str) -> object:
    if isinstance(current, dict):
        return current.get(part)
    if isinstance(current, list):
        if part == "length":
            return len(current)
        index = _array_index(part)
        if index is None or index >= len(current):
            return None
        return current[index]
    return None


def _unset(root: object, path: str) -> None:
    parts = path.split(".")
    current = root
    for part in parts[:-1]:
        if current is None or not isinstance(current, (dict, list)):
            return
        current = _child(current, part)
    if current is None:
        return
    last = parts[-1]
    if isinstance(current, dict):
        current.pop(last, None)
        return
    if isinstance(current, list):
        index = _array_index(last)
        if index is not None and index < len(current):
            current[index] = HOLE


def _stripped(payload: object, paths: list[str]) -> object:
    clone = loads_strict(jcs(normalize_payload(payload)))
    if isinstance(clone, dict):
        clone.pop("allowed_drift", None)
    for path in paths:
        _unset(clone, path)
    return clone


def compare_with_drift(approved: object, executed: object) -> DriftComparison:
    if not isinstance(approved, dict):
        raise LedgerError("invalid_request", "payload.action is required", 400)
    raw = approved.get("allowed_drift")
    paths = raw if isinstance(raw, list) else []
    for path in paths:
        if not isinstance(path, str):
            raise LedgerError("invalid_request", "allowed_drift entries must be strings", 400)
        assert_drift_path(path)
    drift_applied = [path for path in paths if not _same_found(_lookup(approved, path), _lookup(executed, path))]
    match = jcs(_stripped(approved, paths)) == jcs(_stripped(executed, paths))
    return DriftComparison(match, drift_applied)
