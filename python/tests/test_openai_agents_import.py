from __future__ import annotations

import subprocess
import sys


def test_import_actledger_without_openai_agents_extra() -> None:
    ok = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.modules['agents'] = None; import actledger; import actledger.gate",
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
            "import sys; sys.modules['agents'] = None; import actledger.openai_agents",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert bad.returncode != 0
    assert "actledger[openai-agents]" in (bad.stderr + bad.stdout)
