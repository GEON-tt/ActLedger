"""Claude Agent SDK adapter. Import this module directly; it is not loaded by ``actledger``."""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING, Any, Callable

try:
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        HookMatcher,
        PermissionResultAllow,
        PermissionResultDeny,
    )
except ImportError as error:  # pragma: no cover - exercised by test_import_without_extra
    raise ImportError("pip install 'actledger[claude]'") from error

if TYPE_CHECKING:
    from claude_agent_sdk import HookContext, ToolPermissionContext
    from .gate import ToolGate, ToolGateDeny, ToolGatePending
    from .ledger import Run


def _error_text(error: BaseException) -> str:
    text = str(error)
    return text if text else type(error).__name__


def _tool_error_text(tool_response: object) -> str:
    if isinstance(tool_response, dict):
        content = tool_response.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    return item["text"]
    return "tool returned isError"


def _default_tool_input(approved_payload: dict, original: dict, _tool_name: str) -> dict:
    args = approved_payload.get("args") if isinstance(approved_payload, dict) else None
    if isinstance(args, dict):
        return args
    return original


def _default_is_tool_error(tool_response: object) -> bool:
    return isinstance(tool_response, dict) and tool_response.get("isError") is True


def deny_message(tool_name: str, decision: ToolGateDeny | ToolGatePending) -> str:
    """Same sentences as the TypeScript adapter, including the task id and reason."""
    if decision.kind == "pending":
        return f"ActLedger did not allow {tool_name}: pending (task {decision.task_id}). {decision.approve_hint}"
    return (
        f"ActLedger did not allow {tool_name}: {decision.reason} (task {decision.task_id}). "
        f"{decision.message}. Tell the user this action was not performed."
    )


class ClaudeAgentAdapter:
    """Wait-mode ToolGate mounted on ``can_use_tool``, ``PostToolUse``, and ``PostToolUseFailure``.

    The Python SDK's permission context has no abort signal, so this adapter does not
    implement the TypeScript abort cleanup. A missing ``tool_use_id`` is still allowed
    or denied, but it is not stored for the post hooks.
    """

    def __init__(
        self,
        gate: ToolGate,
        *,
        tool_input: Callable[[dict, dict, str], dict] | None = None,
        executed_payload: Callable[[dict, Any, str], dict] | None = None,
        is_tool_error: Callable[[Any], bool] | None = None,
        interrupt_on_deny: bool = False,
        matcher: str | None = None,
        hook_timeout: float | None = None,
        on_error: Callable[[BaseException, dict], None] | None = None,
        on_untracked: Callable[[str, str | None], None] | None = None,
    ) -> None:
        if gate.mode != "wait":
            raise TypeError("claude adapter needs a wait-mode ToolGate")
        self._gate = gate
        self._tool_input = tool_input or _default_tool_input
        self._executed_payload = executed_payload
        self._is_tool_error = is_tool_error or _default_is_tool_error
        self._interrupt = interrupt_on_deny
        self._matcher = matcher
        self._hook_timeout = hook_timeout
        self._on_error = on_error
        self._on_untracked = on_untracked
        self._inflight: dict[str, tuple[Run, str]] = {}

    def _report(self, error: BaseException, phase: str, tool_name: str, tool_use_id: str | None) -> None:
        if self._on_error is None:
            return
        self._on_error(error, {"phase": phase, "tool_name": tool_name, "tool_use_id": tool_use_id})

    async def _track(self, tool_use_id: str, run: Run, tool_name: str) -> None:
        prev = self._inflight.get(tool_use_id)
        if prev is not None:
            old_run, old_name = prev
            self._inflight.pop(tool_use_id, None)
            try:
                await self._gate.async_after(
                    old_run,
                    error="superseded by a new permission request",
                    code="superseded",
                )
            except Exception as error:
                self._report(error, "before", old_name, tool_use_id)
        self._inflight[tool_use_id] = (run, tool_name)

    async def can_use_tool(
        self,
        tool_name: str,
        input: dict[str, Any],
        context: ToolPermissionContext,
    ) -> PermissionResultAllow | PermissionResultDeny:
        tool_use_id = context.tool_use_id
        try:
            decision = await self._gate.async_before(tool_name, input)
        except Exception as error:
            self._report(error, "before", tool_name, tool_use_id)
            return PermissionResultDeny(
                message=f"ActLedger did not allow {tool_name}: ledger error. {_error_text(error)}",
                interrupt=self._interrupt,
            )
        if decision.kind == "allow":
            if decision.run is None:
                return PermissionResultAllow(updated_input=input)
            if tool_use_id:
                await self._track(tool_use_id, decision.run, tool_name)
            return PermissionResultAllow(updated_input=self._tool_input(decision.approved_payload, input, tool_name))
        return PermissionResultDeny(message=deny_message(tool_name, decision), interrupt=self._interrupt)

    def _hook_id(self, hook_input: dict, tool_use_id: str | None) -> str | None:
        raw = hook_input.get("tool_use_id") or tool_use_id
        return raw if isinstance(raw, str) and raw else None

    async def _take(self, hook_input: dict, tool_use_id: str | None) -> tuple[Run, str, str] | None:
        tool_name = hook_input.get("tool_name")
        name = tool_name if isinstance(tool_name, str) else ""
        resolved = self._hook_id(hook_input, tool_use_id)
        tracked = self._inflight.pop(resolved, None) if resolved is not None else None
        if tracked is None:
            if self._on_untracked is not None:
                self._on_untracked(name, resolved)
            return None
        run, stored_name = tracked
        return run, stored_name or name, resolved or ""

    async def _after(self, run: Run, tool_name: str, tool_use_id: str | None, **kwargs: Any) -> dict:
        try:
            await self._gate.async_after(run, **kwargs)
        except Exception as error:
            if self._on_error is None:
                raise
            self._report(error, "after", tool_name, tool_use_id)
        return {}

    async def post_tool_use(self, input: dict, tool_use_id: str | None, context: HookContext) -> dict:
        del context
        if input.get("hook_event_name") != "PostToolUse":
            return {}
        taken = await self._take(input, tool_use_id)
        if taken is None:
            return {}
        run, tool_name, resolved = taken
        response = input.get("tool_response")
        if self._is_tool_error(response):
            return await self._after(run, tool_name, resolved, error=_tool_error_text(response), code="tool_error")
        if self._executed_payload is None:
            payload = run.approved_payload
        else:
            payload = self._executed_payload(run.approved_payload, input.get("tool_input"), tool_name)
        return await self._after(run, tool_name, resolved, result=response, executed_payload=payload)

    async def post_tool_use_failure(self, input: dict, tool_use_id: str | None, context: HookContext) -> dict:
        del context
        if input.get("hook_event_name") != "PostToolUseFailure":
            return {}
        taken = await self._take(input, tool_use_id)
        if taken is None:
            return {}
        run, tool_name, resolved = taken
        code = "interrupted" if input.get("is_interrupt") else "tool_error"
        error = input.get("error")
        message = error if isinstance(error, str) else _error_text(error) if isinstance(error, BaseException) else str(error)
        return await self._after(run, tool_name, resolved, error=message, code=code)

    @property
    def hooks(self) -> dict[str, list[HookMatcher]]:
        return {
            "PostToolUse": [
                HookMatcher(matcher=self._matcher, hooks=[self.post_tool_use], timeout=self._hook_timeout),
            ],
            "PostToolUseFailure": [
                HookMatcher(matcher=self._matcher, hooks=[self.post_tool_use_failure], timeout=self._hook_timeout),
            ],
        }

    def options(self, base: ClaudeAgentOptions | None = None) -> ClaudeAgentOptions:
        if base is None:
            base = ClaudeAgentOptions()
        if base.can_use_tool is not None:
            raise TypeError("options already has can_use_tool")
        if base.permission_prompt_tool_name is not None:
            raise TypeError("options already has permission_prompt_tool_name")
        merged: dict[Any, list[HookMatcher]] = {}
        if base.hooks:
            for event, matchers in base.hooks.items():
                merged[event] = list(matchers)
        for event, matchers in self.hooks.items():
            merged[event] = [*merged.get(event, []), *matchers]
        return replace(base, can_use_tool=self.can_use_tool, hooks=merged)

    @property
    def in_flight(self) -> int:
        return len(self._inflight)

    async def abandon(self, reason: str = "abandoned") -> None:
        pending = list(self._inflight.items())
        self._inflight.clear()
        failure: BaseException | None = None
        for tool_use_id, (run, tool_name) in pending:
            try:
                await self._gate.async_after(run, error=reason, code="abandoned")
            except Exception as error:
                if self._on_error is not None:
                    self._report(error, "abandon", tool_name, tool_use_id)
                elif failure is None:
                    failure = error
        if failure is not None:
            raise failure


def claude_agent_adapter(gate: ToolGate, **kwargs: Any) -> ClaudeAgentAdapter:
    return ClaudeAgentAdapter(gate, **kwargs)
