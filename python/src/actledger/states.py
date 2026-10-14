from __future__ import annotations

from .errors import LedgerError

STATES = (
    "prepared",
    "pending_approval",
    "approved",
    "executing",
    "executed",
    "failed",
    "unknown",
    "rejected",
    "drafted",
    "expired",
    "revoked",
)

TERMINAL_STATES = frozenset({"executed", "failed", "rejected", "drafted", "expired", "revoked"})

TRANSITIONS: dict[str, tuple[str, ...]] = {
    "prepared": ("approved", "pending_approval", "rejected", "drafted"),
    "pending_approval": ("approved", "rejected", "expired", "revoked"),
    "approved": ("executing", "revoked", "expired"),
    "executing": ("executed", "failed", "unknown"),
    "executed": (),
    "failed": (),
    "unknown": ("executed", "failed"),
    "rejected": (),
    "drafted": (),
    "expired": (),
    "revoked": (),
}


def is_state(value: str) -> bool:
    return value in STATES


def can_transition(from_state: str, to_state: str) -> bool:
    allowed = TRANSITIONS.get(from_state)
    return allowed is not None and to_state in allowed


def assert_transition(from_state: str, to_state: str) -> None:
    if not can_transition(from_state, to_state):
        raise LedgerError("invalid_transition", f"cannot transition from {from_state} to {to_state}", 409)


def is_terminal(state: str) -> bool:
    return state in TERMINAL_STATES
