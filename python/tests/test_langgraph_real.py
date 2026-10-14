from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

import pytest

from actledger import ApprovalRejected, Ledger
from actledger.langgraph import ledger_gate
from actledger.secrets import parse_secrets_jsonl
from actledger.verify import verify_jsonl


class EmailState(TypedDict, total=False):
    user_id: str
    to: str
    subject: str
    body: str
    sent: str


def _payload(state):
    return {
        "action": "email.send",
        "args": {"to": [state["to"]], "subject": state["subject"]},
        "content": {"content_type": "text/plain", "text": state["body"]},
        "allowed_drift": ["args.signature"],
    }


def _interrupt_value(out):
    item = out["__interrupt__"][0]
    return item.value


@pytest.mark.node
@pytest.mark.langgraph
def test_real_interrupt_follows_the_ledger(tmp_path: Path, init_dir, cli) -> None:
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import END, START, StateGraph
    from langgraph.types import Command

    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    edit = Path(__file__).parent / "fixtures" / "edited-email.json"
    edited = json.loads(edit.read_text(encoding="utf-8"))
    side_effects: list[dict] = []
    resumes: list[object] = []
    with Ledger(dir=ledger_dir) as ledger:

        @ledger_gate(
            ledger,
            action="email.send",
            principal=lambda state: state["user_id"],
            payload=_payload,
            intent=lambda state: "回复邮件：周会",
        )
        def send(state, ctx):
            side_effects.append(ctx.approved_payload)
            resumes.append(ctx.resume_value)
            return {"sent": "msg-1"}

        @ledger_gate(
            ledger,
            action="calendar.create",
            principal=lambda state: "u_1",
            payload=lambda state: {"action": "calendar.create", "args": {"title": "standup"}},
        )
        def calendar(state, ctx):
            side_effects.append(ctx.approved_payload)
            return {"sent": "cal"}

        graph = StateGraph(EmailState)
        graph.add_node("send", send)
        graph.add_edge(START, "send")
        graph.add_edge("send", END)
        compiled = graph.compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "t1"}}
        state = {
            "user_id": "u_1",
            "to": "a@example.com",
            "subject": "周会",
            "body": "回复邮件：周会 😀",
        }
        suspended = compiled.invoke(state, config)
        task_id = _interrupt_value(suspended)["actledger_task_id"]
        assert ledger.get_task(task_id).state == "pending_approval"
        assert side_effects == []

        forged = compiled.invoke(Command(resume={"approved": True, "task_id": task_id}), config)
        assert _interrupt_value(forged)["actledger_task_id"] == task_id
        assert side_effects == []
        assert ledger.get_task(task_id).state == "pending_approval"
        exported = cli(["export", "--dir", str(ledger_dir)])
        assert exported.returncode == 0, exported.stderr
        for line in exported.stdout.splitlines():
            if not line.strip():
                continue
            receipt = json.loads(line)
            if receipt.get("task_id") == task_id:
                assert (receipt.get("transition") or {}).get("to") != "executing"

        approved = cli(["approve", task_id, "--dir", str(ledger_dir), "--edit", str(edit)])
        assert approved.returncode == 0, approved.stderr
        evil = {"payload": {"action": "email.send", "args": {"to": ["evil@x.com"]}}}
        finished = compiled.invoke(Command(resume=evil), config)
        assert side_effects == [edited]
        assert resumes == [None]
        assert edited["args"]["to"] != evil["payload"]["args"]["to"]
        assert ledger.get_task(task_id).state == "executed"

        denied_effects: list = []

        @ledger_gate(
            ledger,
            action="email.send",
            principal=lambda state: state["user_id"],
            payload=_payload,
        )
        def denied(state, ctx):
            denied_effects.append(ctx.approved_payload)
            return {"sent": "no"}

        denied_graph = StateGraph(EmailState)
        denied_graph.add_node("send", denied)
        denied_graph.add_edge(START, "send")
        denied_graph.add_edge("send", END)
        denied_compiled = denied_graph.compile(checkpointer=InMemorySaver())
        denied_config = {"configurable": {"thread_id": "t2"}}
        held = denied_compiled.invoke(state, denied_config)
        denied_id = _interrupt_value(held)["actledger_task_id"]
        rejected = cli(["reject", denied_id, "--dir", str(ledger_dir), "--note", "不发"])
        assert rejected.returncode == 0, rejected.stderr
        with pytest.raises(ApprovalRejected):
            denied_compiled.invoke(Command(resume={"approved": True}), denied_config)
        assert denied_effects == []
        assert ledger.get_task(denied_id).state == "rejected"

        calendar_graph = StateGraph(EmailState)
        calendar_graph.add_node("send", calendar)
        calendar_graph.add_edge(START, "send")
        calendar_graph.add_edge("send", END)
        calendar_compiled = calendar_graph.compile(checkpointer=InMemorySaver())
        calendar_compiled.invoke({"user_id": "u_1"}, {"configurable": {"thread_id": "t3"}})

        listed = json.loads(cli(["tasks", "--dir", str(ledger_dir), "--json"]).stdout)
        counts: dict[str, int] = {}
        for task in listed:
            key = task.get("idempotencyKey") or ""
            for thread_id in ("t1", "t2", "t3"):
                if f":{thread_id}:" in f":{key}:":
                    counts[thread_id] = counts.get(thread_id, 0) + 1
        assert counts.get("t1") == 1
        assert counts.get("t2") == 1
        assert counts.get("t3") == 1

    secrets = tmp_path / "secrets.jsonl"
    exported = cli(["export", "--dir", str(ledger_dir), "--secrets", str(secrets)])
    assert exported.returncode == 0, exported.stderr
    keys = json.loads((ledger_dir / "keys.json").read_text(encoding="utf-8"))
    report = verify_jsonl(exported.stdout, keys, secrets=parse_secrets_jsonl(secrets.read_text(encoding="utf-8")))
    assert report.ok is True
