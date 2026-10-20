"""OpenAI Agents SDK adapter. Import this module directly; it is not loaded by ``actledger``."""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
import functools
import inspect
import json
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping

from .ledger import Ledger, Run

try:
    from agents import Agent, FunctionTool, RunState, function_tool as build_function_tool
    from agents.tool_context import ToolContext
except ImportError as error:  # pragma: no cover - exercised by test_openai_agents_import
    raise ImportError("pip install 'actledger[openai-agents]'") from error


SDK_DEFAULT_TOOL_ERROR = "An error occurred while running the tool. Please try again."

_SLOT: contextvars.ContextVar[_CallSlot | None] = contextvars.ContextVar("actledger_openai_call_slot", default=None)


class ActLedgerToolError(Exception):
    """Raised when a tool call has no call id, or a structured tool must refuse."""


class _CallSlot:
    def __init__(self) -> None:
        self.error: BaseException | None = None


@dataclass
class ResolvedInterruptions:
    state: RunState
    approved: list
    rejected: list
    pending: list
    untracked: list


def deny_message(tool_name: str, reason: str, task_id: str | None) -> str:
    return f"ActLedger did not allow {tool_name}: {reason} (task {task_id})."


def _is_plain_object(value: object) -> bool:
    return isinstance(value, dict)


def _sort(value: object) -> object:
    if isinstance(value, dict):
        return {key: _sort(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sort(item) for item in value]
    return value


def _same_json(left: object, right: object) -> bool:
    try:
        return json.dumps(_sort(left), sort_keys=True, separators=(",", ":")) == json.dumps(
            _sort(right), sort_keys=True, separators=(",", ":")
        )
    except TypeError:
        return False


def _normalize(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _ledger_input(sdk_input: object) -> object:
    normalized = _normalize(sdk_input)
    return normalized if _is_plain_object(normalized) else sdk_input


def _args_edited(approved_payload: dict, sdk_input: object) -> bool:
    args = approved_payload.get("args") if isinstance(approved_payload, dict) else None
    return isinstance(args, dict) and not _same_json(args, _normalize(sdk_input))


def _default_tool_input(approved_payload: dict, sdk_input: object, _tool_name: str) -> object:
    args = approved_payload.get("args") if isinstance(approved_payload, dict) else None
    if isinstance(args, dict) and not _same_json(args, _normalize(sdk_input)):
        return args
    return sdk_input


def _default_executed_payload(approved_payload: dict, _tool_input: object, _tool_name: str) -> dict:
    return approved_payload


def _default_is_tool_error(output: object, _tool_name: str) -> bool:
    return output == SDK_DEFAULT_TOOL_ERROR


def _invoke_input(chosen: object, sdk_input: object, edited: bool) -> str:
    if not edited and chosen == sdk_input and isinstance(sdk_input, str):
        return sdk_input
    if not edited and isinstance(sdk_input, str) and _same_json(chosen, _normalize(sdk_input)):
        return sdk_input
    if isinstance(chosen, str):
        return chosen
    return json.dumps(chosen)


def _call_id_of(ctx: object) -> str | None:
    call_id = ctx.tool_call_id if isinstance(ctx, ToolContext) else getattr(ctx, "tool_call_id", None)
    return call_id if isinstance(call_id, str) and call_id else None


def _reason_of(handle: object) -> str:
    if handle is None:
        return "not_found"
    state = getattr(handle, "state", None)
    decision = getattr(handle, "decision", None)
    result = decision.get("result") if isinstance(decision, dict) else None
    if state == "rejected" and result == "deny":
        return "policy_denied"
    return str(state)


def _capture(func: Callable[..., Any]) -> Callable[..., Any]:
    if inspect.iscoroutinefunction(func):

        @functools.wraps(func)
        async def async_wrapped(*args: Any, **kwargs: Any) -> Any:
            try:
                return await func(*args, **kwargs)
            except Exception as error:
                slot = _SLOT.get()
                if slot is not None:
                    slot.error = error
                raise

        return async_wrapped

    @functools.wraps(func)
    def sync_wrapped(*args: Any, **kwargs: Any) -> Any:
        try:
            return func(*args, **kwargs)
        except Exception as error:
            slot = _SLOT.get()
            if slot is not None:
                slot.error = error
            raise

    return sync_wrapped


class OpenAIAgentsLedger:
    """Defer-mode ToolGate mounted on OpenAI Agents SDK function tools.

    The binding does not approve or reject ledger tasks.
    """

    def __init__(
        self,
        gate: Any,
        ledger: Ledger,
        *,
        tool_input: Callable[[dict, Any, str], Any] | None = None,
        executed_payload: Callable[[dict, Any, str], dict] | None = None,
        is_tool_error: Callable[[Any, str], bool] | None = None,
        store: MutableMapping[str, dict] | None = None,
        on_error: Callable[[BaseException, dict], None] | None = None,
        on_unsupported_tool: Callable[[Any], None] | None = None,
    ) -> None:
        if getattr(gate, "mode", None) != "defer":
            raise TypeError("openai agents adapter needs a defer-mode ToolGate")
        self._gate = gate
        self._ledger = ledger
        self._tool_input = tool_input or _default_tool_input
        self._executed_payload = executed_payload or _default_executed_payload
        self._is_tool_error = is_tool_error or _default_is_tool_error
        self._store: MutableMapping[str, dict] = store if store is not None else {}
        self._on_error = on_error
        self._on_unsupported_tool = on_unsupported_tool
        self._held: dict[str, dict] = {}

    @property
    def in_flight(self) -> int:
        return len(self._held)

    def _report(self, error: BaseException, phase: str, tool_name: str, call_id: str | None) -> None:
        if self._on_error is None:
            return
        self._on_error(error, {"phase": phase, "tool_name": tool_name, "call_id": call_id})

    def _needs_approval(self, tool_name: str) -> Callable[..., Any]:
        async def needs_approval(_ctx: object, params: dict, call_id: str) -> bool:
            if not call_id:
                return True
            key = f"{tool_name}:{call_id}"
            if key in self._held:
                return False
            if key in self._store:
                return True
            try:
                decision = await self._gate.async_before(tool_name, _ledger_input(params))
            except Exception as error:
                self._report(error, "before", tool_name, call_id)
                self._store[key] = {"kind": "error", "message": deny_message(tool_name, "ledger_error", None)}
                return True
            if decision.kind == "allow":
                self._held[key] = {"run": decision.run, "approved_payload": decision.approved_payload}
                return False
            if decision.kind == "pending":
                self._store[key] = {"kind": "pending", "taskId": decision.task_id}
                return True
            self._store[key] = {
                "kind": "deny",
                "taskId": decision.task_id,
                "reason": decision.reason,
                "message": deny_message(tool_name, decision.reason, decision.task_id),
            }
            return True

        return needs_approval

    async def _prepare(self, tool_name: str, sdk_input: object, call_id: str | None) -> tuple[Run | None, dict] | str:
        if not call_id:
            raise ActLedgerToolError("no callId; run the tool through the Agents SDK runner")
        key = f"{tool_name}:{call_id}"
        held = self._held.pop(key, None)
        if held is not None:
            self._store.pop(key, None)
            return held["run"], held["approved_payload"]
        entry = self._store.get(key)
        if entry is not None and entry.get("kind") == "pending":
            try:
                decision = await self._gate.async_resume(entry["taskId"])
            except Exception as error:
                self._store.pop(key, None)
                self._report(error, "resume", tool_name, call_id)
                return deny_message(tool_name, "ledger_error", entry["taskId"])
            if decision.kind == "allow":
                self._store.pop(key, None)
                return decision.run, decision.approved_payload
            self._store.pop(key, None)
            if decision.kind == "deny":
                return deny_message(tool_name, decision.reason, decision.task_id)
            return f"{deny_message(tool_name, 'pending', decision.task_id)} {decision.approve_hint}"
        if entry is not None and entry.get("kind") in {"deny", "error"}:
            return str(entry.get("message"))
        try:
            decision = await self._gate.async_before(tool_name, _ledger_input(sdk_input))
        except Exception as error:
            self._report(error, "before", tool_name, call_id)
            return deny_message(tool_name, "ledger_error", None)
        if decision.kind == "allow":
            self._store.pop(key, None)
            return decision.run, decision.approved_payload
        if decision.kind == "pending":
            return f"{deny_message(tool_name, 'pending', decision.task_id)} {decision.approve_hint}"
        return deny_message(tool_name, decision.reason, decision.task_id)

    async def _safe_after(self, run: Run | None, tool_name: str, call_id: str | None, **kwargs: Any) -> None:
        if run is None:
            return
        try:
            await self._gate.async_after(run, **kwargs)
        except Exception as error:
            if self._on_error is None:
                raise
            self._report(error, "after", tool_name, call_id)

    def _invoke_wrapper(self, tool_name: str, inner: Callable[..., Any], *, capture: bool) -> Callable[..., Any]:
        async def wrapped(ctx: object, input_str: str) -> Any:
            call_id = _call_id_of(ctx)
            prepared = await self._prepare(tool_name, input_str, call_id)
            if isinstance(prepared, str):
                return prepared
            run, approved_payload = prepared
            edited = _args_edited(approved_payload, input_str)
            chosen = self._tool_input(approved_payload, input_str, tool_name)
            call_input = _invoke_input(chosen, input_str, edited)
            slot = _CallSlot()
            token = _SLOT.set(slot)
            try:
                try:
                    out = await inner(ctx, call_input)
                except asyncio.CancelledError as error:
                    await self._safe_after(run, tool_name, call_id, error=error, code="cancelled")
                    raise
                except Exception as error:
                    await self._safe_after(run, tool_name, call_id, error=error, code="tool_error")
                    raise
                if capture and slot.error is not None:
                    await self._safe_after(run, tool_name, call_id, error=slot.error, code="tool_error")
                elif not capture and self._is_tool_error(out, tool_name):
                    text = out if isinstance(out, str) else SDK_DEFAULT_TOOL_ERROR
                    await self._safe_after(run, tool_name, call_id, error=text, code="tool_error")
                else:
                    payload = self._executed_payload(approved_payload, chosen, tool_name)
                    await self._safe_after(run, tool_name, call_id, result=out, executed_payload=payload)
                return out
            finally:
                _SLOT.reset(token)

        return wrapped

    def function_tool(self, func: Callable[..., Any] | None = None, **kwargs: Any) -> Any:
        if "needs_approval" in kwargs:
            raise TypeError("function_tool owns needs_approval; remove it from the options")

        def decorate(fn: Callable[..., Any]) -> FunctionTool:
            wrapped_fn = _capture(fn)
            created = build_function_tool(wrapped_fn, needs_approval=self._needs_approval(fn.__name__), **kwargs)
            return dataclasses.replace(
                created,
                needs_approval=self._needs_approval(created.name),
                on_invoke_tool=self._invoke_wrapper(created.name, created.on_invoke_tool, capture=True),
            )

        if func is not None:
            return decorate(func)
        return decorate

    async def abandon(self, reason: str | None = None) -> None:
        message = reason or "run abandoned before the tool executed"
        pending = list(self._held.items())
        self._held.clear()
        failure: BaseException | None = None
        for key, held in pending:
            run = held.get("run")
            if run is None:
                continue
            colon = key.find(":")
            tool_name = key if colon == -1 else key[:colon]
            call_id = None if colon == -1 else key[colon + 1 :]
            try:
                await asyncio.to_thread(run.fail, error={"code": "abandoned", "message": message})
            except Exception as error:
                if self._on_error is not None:
                    self._report(error, "abandon", tool_name, call_id)
                elif failure is None:
                    failure = error
        if failure is not None:
            raise failure


def openai_agents_ledger(gate: Any, ledger: Ledger, **kwargs: Any) -> OpenAIAgentsLedger:
    return OpenAIAgentsLedger(gate, ledger, **kwargs)


def with_ledger(tool: FunctionTool, binding: OpenAIAgentsLedger) -> FunctionTool:
    if not isinstance(tool, FunctionTool):
        raise TypeError("with_ledger only wraps function tools")
    return dataclasses.replace(
        tool,
        needs_approval=binding._needs_approval(tool.name),
        on_invoke_tool=binding._invoke_wrapper(tool.name, tool.on_invoke_tool, capture=False),
    )


def with_ledger_agent(agent: Agent, binding: OpenAIAgentsLedger) -> Agent:
    tools = []
    for item in agent.tools:
        if isinstance(item, FunctionTool):
            tools.append(with_ledger(item, binding))
            continue
        if binding._on_unsupported_tool is not None:
            binding._on_unsupported_tool(item)
        tools.append(item)
    return agent.clone(tools=tools)


async def resolve_interruptions(result_or_state: Any, binding: OpenAIAgentsLedger) -> ResolvedInterruptions:
    state = result_or_state.to_state() if hasattr(result_or_state, "to_state") else result_or_state
    approved: list = []
    rejected: list = []
    pending: list = []
    untracked: list = []
    await asyncio.to_thread(binding._ledger.sweep)
    for item in list(state.get_interruptions()):
        name = item.name
        call_id = item.call_id
        if not name or not call_id:
            untracked.append(item)
            continue
        entry = binding._store.get(f"{name}:{call_id}")
        if entry is None:
            untracked.append(item)
            continue
        if entry.get("kind") == "deny":
            state.reject(item, rejection_message=entry["message"])
            binding._store.pop(f"{name}:{call_id}", None)
            rejected.append((item, entry.get("taskId"), entry.get("reason")))
            continue
        if entry.get("kind") == "error":
            state.reject(item, rejection_message=entry["message"])
            binding._store.pop(f"{name}:{call_id}", None)
            rejected.append((item, None, "ledger_error"))
            continue
        try:
            handle = await asyncio.to_thread(binding._ledger.get_task, entry["taskId"])
        except Exception as error:
            binding._report(error, "resolve", name, call_id)
            pending.append((item, entry["taskId"], binding._ledger.approve_hint(entry["taskId"])))
            continue
        if handle is not None and handle.state == "approved":
            state.approve(item)
            approved.append(item)
            continue
        if handle is not None and handle.state == "pending_approval":
            pending.append((item, entry["taskId"], binding._ledger.approve_hint(entry["taskId"], handle.decision)))
            continue
        reason = _reason_of(handle)
        state.reject(item, rejection_message=deny_message(name, reason, entry["taskId"]))
        binding._store.pop(f"{name}:{call_id}", None)
        rejected.append((item, entry["taskId"], reason))
    return ResolvedInterruptions(state, approved, rejected, pending, untracked)
