from __future__ import annotations

import subprocess
import sys


def test_import_actledger_without_claude_extra() -> None:
    ok = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.modules['claude_agent_sdk'] = None; import actledger; import actledger.gate",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert ok.returncode == 0, ok.stderr or ok.stdout
    bad = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.modules['claude_agent_sdk'] = None; import actledger.claude_agent",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert bad.returncode != 0
    assert "actledger[claude]" in (bad.stderr + bad.stdout)
