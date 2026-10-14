from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ._ids import uuidv7
from .errors import ApprovalExpired, ApprovalRejected, ApprovalRevoked, ContentMismatch, LedgerError
from .ledger import Ledger
from .payload import compare_with_drift


@dataclass
class GateContext:
    task_id: str
    approved_payload: dict
    resumed: bool
    resume_value: object | None


def _idempotency_key(state: object, callback: Callable | None, index: int) -> str:
    if callback is not None:
        return callback(state)
    try:
        from langgraph.config import get_config

        config = get_config()
    except Exception:
        return uuidv7()
    configurable = config.get("configurable") if isinstance(config, dict) else None
    if not isinstance(configurable, dict):
        return uuidv7()
    thread_id = configurable.get("thread_id")
    if not thread_id:
        return uuidv7()
    checkpoint_ns = configurable.get("checkpoint_ns") or ""
    return f"lg:{thread_id}:{checkpoint_ns}:{index}"


def _interrupt(value: object, interrupt_fn: Callable | None) -> object:
    if interrupt_fn is not None:
        return interrupt_fn(value)
    try:
        from langgraph.types import interrupt
    except ImportError as error:
        raise ImportError("pip install 'actledger[langgraph]'") from error
    return interrupt(value)


def ledger_gate(
    ledger: Ledger,
    *,
    action: str | Callable,
    principal: Callable,
    payload: Callable,
    intent: Callable | None = None,
    agent_id: str | None = None,
    executed_payload: Callable | None = None,
    idempotency_key: Callable | None = None,
    on_denied: Callable | None = None,
    interrupt_fn: Callable | None = None,
) -> Callable:
    def decorator(fn: Callable) -> Callable:
        def node(state):
            resolved = action(state) if callable(action) else {"type": action}
            body = payload(state)
            if isinstance(body, dict) and body.get("action") != resolved.get("type"):
                body["action"] = resolved["type"]
            task = ledger.request(
                principal_id=principal(state),
                action=resolved,
                payload=body,
                intent=intent(state) if intent is not None else None,
                agent_id=agent_id,
                idempotency_key=_idempotency_key(state, idempotency_key, 0),
            )
            current = ledger.get_task(task.id)
            if current is None:
                raise LedgerError("not_found", f"task {task.id} not found", 404)
            resumed = False
            resume_value = None
            while True:
                state_name = current.state
                if state_name == "pending_approval":
                    resume_value = _interrupt(
                        {
                            "actledger_task_id": current.id,
                            "action": resolved.get("type"),
                            "payload_hash": current.data.get("payloadHash"),
                            "hint": f"actledger approve {current.id} --dir {ledger.dir}",
                        },
                        interrupt_fn,
                    )
                    resumed = True
                    current = ledger.get_task(current.id)
                    if current is None:
                        raise LedgerError("not_found", f"task {task.id} not found", 404)
                    continue
                if state_name == "approved":
                    break
                if state_name in ("rejected", "expired", "revoked"):
                    if on_denied is not None:
                        return on_denied(state, current)
                    if state_name == "rejected":
                        raise ApprovalRejected(current)
                    if state_name == "expired":
                        raise ApprovalExpired(current)
                    raise ApprovalRevoked(current)
                raise LedgerError("invalid_transition", f"task {current.id} is {state_name}, not approved", 409)
            run = current.claim()
            executed = executed_payload(state, run.approved_payload) if executed_payload is not None else run.approved_payload
            if ledger.strict_content and not compare_with_drift(run.approved_payload, executed).match:
                run.fail(
                    error={
                        "code": "content_mismatch",
                        "message": "executed payload does not match the approved payload",
                    }
                )
                raise ContentMismatch()
            update = fn(state, GateContext(run.task_id, run.approved_payload, resumed, resume_value))
            proofs = None
            if isinstance(update, dict) and "_proofs" in update:
                update = dict(update)
                proofs = update.pop("_proofs")
            run.complete(executed_payload=executed, external_proofs=proofs)
            return update

        return node

    return decorator
