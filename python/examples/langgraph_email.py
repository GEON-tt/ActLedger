"""LangGraph email gate. The sender is injected; this example does not contact a mail service."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from actledger import Ledger
from actledger.langgraph import ledger_gate


def build_graph(ledger: Ledger, sender: Callable[[dict], str]):
    from typing import TypedDict

    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import END, START, StateGraph

    class EmailState(TypedDict, total=False):
        user_id: str
        to: str
        subject: str
        body: str
        sent: str

    @ledger_gate(
        ledger,
        action="email.send",
        principal=lambda state: state["user_id"],
        payload=lambda state: {
            "action": "email.send",
            "args": {"to": [state["to"]], "subject": state["subject"]},
            "content": {"content_type": "text/plain", "text": state["body"]},
        },
        intent=lambda state: f"回复邮件：{state['subject']}",
    )
    def send(state, ctx):
        message_id = sender(ctx.approved_payload)
        return {"sent": message_id, "_proofs": [{"type": "email_msgid", "value": message_id}]}

    graph = StateGraph(EmailState)
    graph.add_node("send", send)
    graph.add_edge(START, "send")
    graph.add_edge("send", END)
    return graph.compile(checkpointer=InMemorySaver())


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "packages" / "cli" / "src" / "main.ts").is_file():
            return parent
    raise SystemExit("run this example from the ActLedger repository")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="")
    args = parser.parse_args()
    root = _repo_root()
    if args.dir:
        ledger_dir = Path(args.dir).resolve()
    else:
        ledger_dir = Path(tempfile.mkdtemp(prefix="actledger-mail-"))
        policy = root / "python" / "tests" / "fixtures" / "policy.yaml"
        subprocess.run(
            [
                "node",
                str(root / "node_modules" / "tsx" / "dist" / "cli.mjs"),
                str(root / "packages" / "cli" / "src" / "main.ts"),
                "init",
                "--dir",
                str(ledger_dir),
                "--policy",
                str(policy),
            ],
            cwd=root,
            check=True,
        )
    sent: list[dict] = []
    ledger = Ledger(dir=ledger_dir)
    graph = build_graph(ledger, lambda payload: sent.append(payload) or "msg-1")
    config = {"configurable": {"thread_id": "demo"}}
    state = {"user_id": "u_1", "to": "a@example.com", "subject": "周会", "body": "回复邮件：周会"}
    out = graph.invoke(state, config)
    interrupt = out["__interrupt__"][0].value
    print(json.dumps(interrupt, ensure_ascii=False, indent=2))
    print(f"pnpm actledger approve {interrupt['actledger_task_id']} --dir {ledger_dir}")
    input("批准后按回车继续...")
    from langgraph.types import Command

    finished = graph.invoke(Command(resume={}), config)
    print(finished.get("sent"))
    print(f"python -m actledger verify  # export first: pnpm actledger export --dir {ledger_dir}")
    ledger.close()


if __name__ == "__main__":
    main()
