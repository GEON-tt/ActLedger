from __future__ import annotations

import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO_ROOT = Path(__file__).resolve().parents[2]
TSX = REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
CLI = REPO_ROOT / "packages" / "cli" / "src" / "main.ts"
VECTORS = REPO_ROOT / "spec" / "test-vectors"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
PARITY = REPO_ROOT / "scripts" / "verify-parity.ts"
_SKIP_NODE = "先在仓库根执行 pnpm install"


def node_available() -> bool:
    return shutil.which("node") is not None and TSX.is_file() and CLI.is_file()


def _node_env() -> dict[str, str]:
    env = os.environ.copy()
    flag = "--disable-warning=ExperimentalWarning"
    current = env.get("NODE_OPTIONS", "")
    if flag not in current:
        env["NODE_OPTIONS"] = f"{current} {flag}".strip()
    return env


def require_node() -> str:
    node = shutil.which("node")
    if node and TSX.is_file() and CLI.is_file():
        return node
    if os.environ.get("ACTLEDGER_REQUIRE_NODE") == "1":
        pytest.fail(_SKIP_NODE)
    pytest.skip(_SKIP_NODE)


def pytest_runtest_setup(item: pytest.Item) -> None:
    if item.get_closest_marker("node") and not node_available():
        if os.environ.get("ACTLEDGER_REQUIRE_NODE") == "1":
            pytest.fail(_SKIP_NODE)
        pytest.skip(_SKIP_NODE)
    if item.get_closest_marker("langgraph"):
        if os.environ.get("ACTLEDGER_REQUIRE_LANGGRAPH") == "1":
            __import__("langgraph")
        else:
            pytest.importorskip("langgraph")
    if item.get_closest_marker("claude"):
        if os.environ.get("ACTLEDGER_REQUIRE_CLAUDE") == "1":
            __import__("claude_agent_sdk")
        else:
            pytest.importorskip("claude_agent_sdk")
    if item.get_closest_marker("anthropic_api") and not os.environ.get("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set")
    if item.get_closest_marker("openai_agents"):
        if os.environ.get("ACTLEDGER_REQUIRE_OPENAI") == "1":
            importlib.metadata.version("openai-agents")
            __import__("agents.testing")
        else:
            try:
                importlib.metadata.version("openai-agents")
            except importlib.metadata.PackageNotFoundError:
                pytest.skip("openai-agents not installed")
            pytest.importorskip("agents.testing")
    if item.get_closest_marker("openai_api") and not os.environ.get("OPENAI_API_KEY"):
        pytest.skip("OPENAI_API_KEY not set")


def run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    node = require_node()
    return subprocess.run(
        [node, str(TSX), str(CLI), *args],
        cwd=REPO_ROOT,
        env=_node_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def run_parity(batch: dict) -> dict:
    node = require_node()
    proc = subprocess.run(
        [node, str(TSX), str(PARITY)],
        cwd=REPO_ROOT,
        env=_node_env(),
        input=json.dumps(batch),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if proc.returncode != 0:
        pytest.fail(proc.stderr[-4000:] or proc.stdout[-4000:])
    return json.loads(proc.stdout)


def init_ledger(directory: Path) -> None:
    result = run_cli(["init", "--dir", str(directory), "--policy", str(FIXTURES / "policy.yaml")])
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)


@pytest.fixture
def vectors() -> Path:
    return VECTORS


@pytest.fixture
def parity():
    return run_parity


@pytest.fixture
def cli():
    return run_cli


@pytest.fixture
def init_dir():
    return init_ledger
