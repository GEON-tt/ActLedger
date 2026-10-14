from __future__ import annotations

import inspect
import os
import time
from dataclasses import dataclass

from . import _wire
from ._ids import uuidv7
from ._rpc import RpcClient
from .errors import (
    ApprovalExpired,
    ApprovalRejected,
    ApprovalRevoked,
    ContentMismatch,
    LedgerError,
    LedgerUnavailable,
)
from .gate import ToolGate, ToolMapping
from .payload import compare_with_drift


@dataclass
class GuardContext:
    approved_payload: dict
    task_id: str | None
    degraded: bool


class Run:
    def __init__(self, ledger: Ledger, claimed: dict) -> None:
        self._ledger = ledger
        self._claimed = claimed

    @property
    def task_id(self) -> str:
        return self._claimed["task"]["id"]

    @property
    def approved_payload(self) -> dict:
        return self._claimed["approvedPayload"]

    @property
    def execution_deadline(self) -> str:
        return self._claimed["executionDeadline"]

    def complete(
        self,
        *,
        executed_payload: dict,
        external_proofs: list[dict] | None = None,
        result: dict | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        if self._ledger.strict_content and not compare_with_drift(self.approved_payload, executed_payload).match:
            self.fail(
                error={
                    "code": "content_mismatch",
                    "message": "executed payload does not match the approved payload",
                }
            )
            raise ContentMismatch()
        try:
            completed = self._ledger._rpc.call(
                "complete",
                _wire.complete_params(
                    self.task_id,
                    executed_payload,
                    external_proofs=external_proofs,
                    result=result,
                    idempotency_key=idempotency_key or uuidv7(),
                ),
            )
        except LedgerError as error:
            if error.code == "content_mismatch":
                raise ContentMismatch(str(error)) from error
            raise
        return completed["receipt"]

    def fail(self, *, error: dict) -> None:
        self._ledger._rpc.call("fail", _wire.fail_params(self.task_id, error, uuidv7()))


class TaskHandle:
    def __init__(self, ledger: Ledger, data: dict, degraded: bool = False) -> None:
        self._ledger = ledger
        self.data = data
        self.degraded = degraded

    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def state(self) -> str:
        return self.data["state"]

    @property
    def decision(self) -> dict:
        return self.data["decision"]

    @classmethod
    def degraded(cls, ledger: Ledger, payload_hash: str = "sha256:degraded") -> TaskHandle:
        return cls(ledger, _wire.degraded_task_view(payload_hash), True)

    def wait(self, *, timeout: float = 900.0, poll_interval: float = 0.2) -> TaskHandle:
        if self.degraded:
            return self
        started = time.monotonic()
        current = self.data
        while current.get("state") == "pending_approval":
            self._ledger.sweep()
            nxt = self._ledger.get_task(self.id)
            if nxt is None:
                raise LedgerError("not_found", f"task {self.id} not found", 404)
            current = nxt.data
            if current.get("state") != "pending_approval":
                break
            if time.monotonic() - started >= timeout:
                raise ApprovalExpired(TaskHandle(self._ledger, current), "wait timed out")
            time.sleep(poll_interval)
        handle = TaskHandle(self._ledger, current)
        state = current.get("state")
        if state == "rejected":
            raise ApprovalRejected(handle)
        if state == "expired":
            raise ApprovalExpired(handle)
        if state == "revoked":
            raise ApprovalRevoked(handle)
        return handle

    def claim(self) -> Run:
        if self.degraded:
            raise LedgerUnavailable("degraded read-only task cannot be claimed")
        return self._ledger._claim(self.id)


class Ledger:
    def __init__(
        self,
        *,
        mode: str = "local",
        dir: str | os.PathLike = ".actledger",
        strict_content: bool = True,
        on_unavailable: str = "deny",
        coverage_overlay: list[dict] | None = None,
        command: list[str] | None = None,
        call_timeout: float = 30.0,
    ) -> None:
        if mode != "local":
            raise LedgerError("invalid_request", "pass mode='local'", 400)
        self.strict_content = strict_content
        self.on_unavailable = on_unavailable
        self.dir = os.path.abspath(dir)
        self._rpc = RpcClient(self.dir, command=command, call_timeout=call_timeout)
        if coverage_overlay:
            try:
                self.set_coverage_overlay(coverage_overlay)
            except Exception:
                self.close()
                raise

    def request(
        self,
        *,
        principal_id: str,
        action: dict,
        payload: dict,
        intent: str | None = None,
        agent_id: str | None = None,
        expires_in: int | None = None,
        idempotency_key: str | None = None,
        metadata: dict | None = None,
        read_only: bool = False,
    ) -> TaskHandle:
        try:
            result = self._rpc.call(
                "request",
                _wire.request_params(
                    principal_id=principal_id,
                    action=action,
                    payload=payload,
                    intent=intent,
                    agent_id=agent_id,
                    expires_in=expires_in,
                    idempotency_key=idempotency_key or uuidv7(),
                    metadata=metadata,
                ),
            )
        except LedgerUnavailable:
            if self.on_unavailable == "allow_read_only" and read_only:
                return TaskHandle.degraded(self)
            raise
        return TaskHandle(self, result["task"])

    def get_task(self, task_id: str) -> TaskHandle | None:
        try:
            result = self._rpc.call("get_task", {"id": task_id})
        except LedgerUnavailable:
            if self.on_unavailable == "allow_read_only":
                return None
            raise
        task = result.get("task")
        if not isinstance(task, dict):
            return None
        return TaskHandle(self, task)

    def revoke(self, task_id: str, reason: str | None = None) -> None:
        self._rpc.call("revoke", _wire.revoke_params(task_id, uuidv7(), reason))

    def sweep(self) -> None:
        self._rpc.call("sweep", {})

    def set_coverage_overlay(self, entries: list[dict]) -> None:
        self._rpc.call("set_coverage_overlay", {"entries": entries})

    def _claim(self, task_id: str) -> Run:
        claimed = self._rpc.call("claim", _wire.claim_params(task_id, uuidv7()))
        return Run(self, claimed)

    def guard(
        self,
        *,
        action,
        principal,
        payload,
        intent=None,
        agent_id: str | None = None,
        read_only=None,
        executed_payload=None,
        timeout: float | None = None,
        idempotency_key=None,
    ):
        gate = ToolGate(
            self,
            mode="wait",
            agent_id=agent_id,
            timeout=timeout or 900,
            poll_interval=0.02,
            principal=lambda _tool, kw: principal(kw),
            map=lambda _tool, kw: ToolMapping(
                action=action(kw) if callable(action) else {"type": action},
                payload=payload(kw),
                intent=intent(kw) if intent is not None else None,
                idempotency_key=idempotency_key(kw) if idempotency_key is not None else None,
                read_only=read_only(kw) if read_only is not None else False,
            ),
        )
        tool_name = action if isinstance(action, str) else "guard"

        def decorator(fn):
            signature = inspect.signature(fn)
            parameter = signature.parameters.get("ctx")
            accepts_ctx = parameter is not None and parameter.kind in (
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                inspect.Parameter.KEYWORD_ONLY,
            )

            def wrapper(**kw):
                decision = gate.before(tool_name, kw)
                if decision.kind == "deny":
                    raise decision.cause
                if decision.kind == "pending":
                    raise LedgerError(
                        "invalid_transition",
                        f"task {decision.task_id} is pending_approval, not approved",
                        409,
                    )
                if decision.degraded or decision.run is None:
                    ctx = GuardContext(decision.approved_payload, None, True)
                    return fn(**kw, ctx=ctx) if accepts_ctx else fn(**kw)
                run = decision.run
                executed = (
                    executed_payload(kw, run.approved_payload)
                    if executed_payload is not None
                    else run.approved_payload
                )
                if self.strict_content and not compare_with_drift(run.approved_payload, executed).match:
                    run.fail(
                        error={
                            "code": "content_mismatch",
                            "message": "executed payload does not match the approved payload",
                        }
                    )
                    raise ContentMismatch()
                ctx = GuardContext(run.approved_payload, run.task_id, False)
                result = fn(**kw, ctx=ctx) if accepts_ctx else fn(**kw)
                gate.after(run, result=result, executed_payload=executed)
                return result

            return wrapper

        return decorator

    def close(self) -> None:
        self._rpc.close()

    def __enter__(self) -> Ledger:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
