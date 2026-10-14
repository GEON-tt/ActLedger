from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Literal, Union

from .errors import ApprovalExpired, ApprovalRejected, ApprovalRevoked, LedgerError

if TYPE_CHECKING:
    from .ledger import Ledger, Run, TaskHandle

ToolGateMode = Literal["wait", "defer"]
ToolGateDenyReason = Literal["rejected", "policy_denied", "drafted", "expired", "revoked", "timeout"]

_MISSING = object()


@dataclass
class ToolMapping:
    action: str | dict
    payload: dict | None = None
    intent: str | None = None
    idempotency_key: str | None = None
    read_only: bool = False
    expires_in: int | None = None
    metadata: dict | None = None


@dataclass
class ToolGateAllow:
    run: Run | None
    task_id: str | None
    approved_payload: dict
    degraded: bool = False
    kind: Literal["allow"] = field(default="allow", init=False)


@dataclass
class ToolGateDeny:
    task_id: str
    reason: ToolGateDenyReason
    message: str
    state: str
    cause: Exception
    kind: Literal["deny"] = field(default="deny", init=False)


@dataclass
class ToolGatePending:
    task_id: str
    approve_hint: str
    kind: Literal["pending"] = field(default="pending", init=False)


ToolGateDecision = Union[ToolGateAllow, ToolGateDeny, ToolGatePending]


def default_tool_mapping(tool_name: str, input: Any) -> ToolMapping:
    action_type = f"tool.{tool_name}"
    args = input if isinstance(input, dict) else {"input": input}
    return ToolMapping(action={"type": action_type}, payload={"action": action_type, "args": args})


def approve_hint(task_id: str, dir: str | None) -> str:
    flag = f" --dir {dir}" if dir else ""
    return (
        f"Task {task_id} is waiting for approval. "
        f"Approve: actledger approve {task_id}{flag}  Reject: actledger reject {task_id}{flag}"
    )


def _default_payload(action_type: str, input: Any) -> dict:
    args = input if isinstance(input, dict) else {"input": input}
    return {"action": action_type, "args": args}


def _decision_result(task: object) -> object:
    decision = getattr(task, "decision", None)
    if isinstance(decision, dict):
        return decision.get("result")
    return None


def _error_message(error: BaseException | str) -> str:
    if isinstance(error, str):
        return error
    text = str(error)
    return text if text else type(error).__name__


def _deny_from_wait(error: ApprovalRejected | ApprovalExpired | ApprovalRevoked) -> ToolGateDeny:
    task = error.task
    if isinstance(error, ApprovalRejected):
        reason: ToolGateDenyReason = "policy_denied" if _decision_result(task) == "deny" else "rejected"
        state = "rejected"
    elif isinstance(error, ApprovalExpired):
        pending = task is not None and getattr(task, "state", None) == "pending_approval"
        reason = "timeout" if pending else "expired"
        state = getattr(task, "state", None) or "expired"
    else:
        reason = "revoked"
        state = getattr(task, "state", None) or "revoked"
    task_id = getattr(task, "id", "")
    if not isinstance(task_id, str):
        task_id = "" if task_id is None else str(task_id)
    return ToolGateDeny(task_id, reason, str(error), str(state), error)


def _coerce_mapping(value: ToolMapping | dict) -> ToolMapping:
    if isinstance(value, ToolMapping):
        return value
    if isinstance(value, dict):
        return ToolMapping(**value)
    raise TypeError("map() must return a ToolMapping or a dict")


class ToolGate:
    def __init__(
        self,
        ledger: Ledger,
        *,
        principal: str | Callable[[str, Any], str],
        mode: ToolGateMode,
        agent_id: str | None = None,
        map: Callable[[str, Any], ToolMapping | dict] | None = None,
        timeout: float | None = None,
        poll_interval: float = 0.2,
    ) -> None:
        self._ledger = ledger
        self._principal = principal
        self._mode: ToolGateMode = mode
        self._agent_id = agent_id
        self._map = map
        self._timeout = timeout
        self._poll_interval = poll_interval

    @property
    def mode(self) -> ToolGateMode:
        return self._mode

    def _resolve(self, tool_name: str, input: Any) -> tuple[dict, dict, ToolMapping, str]:
        mapping = default_tool_mapping(tool_name, input) if self._map is None else _coerce_mapping(self._map(tool_name, input))
        action = mapping.action
        resolved = action if isinstance(action, dict) else {"type": action}
        body = mapping.payload
        if body is None:
            action_type = resolved.get("type")
            body = _default_payload(action_type if isinstance(action_type, str) else "", input)
        if isinstance(body, dict) and body.get("action") != resolved.get("type"):
            body["action"] = resolved["type"]
        principal_id = self._principal if isinstance(self._principal, str) else self._principal(tool_name, input)
        return resolved, body, mapping, principal_id

    def _settle(self, handle: TaskHandle) -> ToolGateDecision:
        state = handle.state
        if state == "approved":
            run = handle.claim()
            return ToolGateAllow(run, run.task_id, run.approved_payload)
        if state == "pending_approval":
            directory = getattr(self._ledger, "dir", None)
            return ToolGatePending(handle.id, approve_hint(handle.id, directory if isinstance(directory, str) else None))
        if state == "rejected":
            reason: ToolGateDenyReason = "policy_denied" if _decision_result(handle) == "deny" else "rejected"
            cause = ApprovalRejected(handle)
            return ToolGateDeny(handle.id, reason, str(cause), "rejected", cause)
        if state == "expired":
            cause = ApprovalExpired(handle)
            return ToolGateDeny(handle.id, "expired", str(cause), "expired", cause)
        if state == "revoked":
            cause = ApprovalRevoked(handle)
            return ToolGateDeny(handle.id, "revoked", str(cause), "revoked", cause)
        if state == "drafted":
            cause = LedgerError("invalid_transition", f"task {handle.id} is drafted, not approved", 409)
            return ToolGateDeny(handle.id, "drafted", str(cause), "drafted", cause)
        raise LedgerError("invalid_transition", f"task {handle.id} is {state}, not approved", 409)

    def before(self, tool_name: str, input: Any) -> ToolGateDecision:
        resolved, body, mapping, principal_id = self._resolve(tool_name, input)
        task = self._ledger.request(
            principal_id=principal_id,
            action=resolved,
            payload=body,
            intent=mapping.intent,
            agent_id=self._agent_id,
            expires_in=mapping.expires_in,
            idempotency_key=mapping.idempotency_key,
            metadata=mapping.metadata,
            read_only=mapping.read_only,
        )
        if task.degraded:
            return ToolGateAllow(None, None, body, True)
        if self._mode == "defer":
            return self._settle(task)
        try:
            done = task.wait(timeout=self._timeout or 900, poll_interval=self._poll_interval)
        except (ApprovalRejected, ApprovalExpired, ApprovalRevoked) as error:
            return _deny_from_wait(error)
        return self._settle(done)

    def after(
        self,
        run: Run | None,
        *,
        result: Any = _MISSING,
        error: BaseException | str | None = None,
        executed_payload: dict | None = None,
        external_proofs: list[dict] | None = None,
        record: dict | None = None,
        code: str = "tool_error",
        retryable: bool | None = None,
    ) -> dict | None:
        if run is None:
            return None
        if error is not None:
            body: dict[str, object] = {"code": code, "message": _error_message(error)}
            if retryable is not None:
                body["retryable"] = retryable
            run.fail(error=body)
            return None
        if result is _MISSING:
            raise TypeError("after() needs result= or error=")
        payload = executed_payload if executed_payload is not None else run.approved_payload
        return run.complete(executed_payload=payload, external_proofs=external_proofs, result=record)

    def resume(self, task_id: str) -> ToolGateDecision:
        self._ledger.sweep()
        handle = self._ledger.get_task(task_id)
        if handle is None:
            raise LedgerError("not_found", f"task {task_id} not found", 404)
        return self._settle(handle)

    async def async_before(self, tool_name: str, input: Any) -> ToolGateDecision:
        return await asyncio.to_thread(self.before, tool_name, input)

    async def async_after(self, run: Run | None, **kwargs: Any) -> dict | None:
        return await asyncio.to_thread(lambda: self.after(run, **kwargs))

    async def async_resume(self, task_id: str) -> ToolGateDecision:
        return await asyncio.to_thread(self.resume, task_id)
