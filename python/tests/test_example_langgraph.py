from __future__ import annotations

import json
from pathlib import Path

import pytest

from actledger import Ledger


@pytest.mark.node
@pytest.mark.langgraph
def test_example_graph_runs_after_cli_approval(tmp_path: Path, init_dir, cli) -> None:
    import importlib.util

    from langgraph.types import Command

    ledger_dir = tmp_path / "ledger"
    init_dir(ledger_dir)
    example = Path(__file__).resolve().parents[1] / "examples" / "langgraph_email.py"
    spec = importlib.util.spec_from_file_location("langgraph_email", example)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sent: list[dict] = []
    with Ledger(dir=ledger_dir) as ledger:
        graph = module.build_graph(ledger, lambda payload: sent.append(payload) or "msg-example")
        config = {"configurable": {"thread_id": "example"}}
        out = graph.invoke(
            {"user_id": "u_1", "to": "a@example.com", "subject": "周会", "body": "回复邮件：周会"},
            config,
        )
        task_id = out["__interrupt__"][0].value["actledger_task_id"]
        approved = cli(["approve", task_id, "--dir", str(ledger_dir)])
        assert approved.returncode == 0, approved.stderr
        finished = graph.invoke(Command(resume={}), config)
        assert finished["sent"] == "msg-example"
    assert sent and sent[0]["action"] == "email.send"
    assert json.dumps(sent[0], ensure_ascii=False)
