from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from actledger.verify import verify_jsonl


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "actledger", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def test_help_and_argument_errors() -> None:
    help_text = _run("--help")
    assert help_text.returncode == 0
    assert "verify" in help_text.stdout
    missing = _run("verify")
    assert missing.returncode == 1
    assert "error: invalid_request: verify requires a file and --keys" in missing.stderr
    unknown_flag = _run("verify", "file", "--keys", "keys", "--nope")
    assert unknown_flag.returncode == 1
    assert "error: invalid_request: unknown flag --nope" in unknown_flag.stderr
    unknown = _run("export")
    assert unknown.returncode == 1
    assert "error: invalid_request: unknown command export" in unknown.stderr


def test_verify_vectors_from_the_cli(vectors: Path) -> None:
    keys = vectors / "keys.json"
    chain = vectors / "receipts-chain-0.2.jsonl"
    secrets = vectors / "secrets-0.2.jsonl"
    ok = _run("verify", str(chain), "--keys", str(keys), "--secrets", str(secrets))
    assert ok.returncode == 0
    assert ok.stdout.startswith("OK ")
    assert "secrets=" in ok.stdout
    legacy = _run("verify", str(vectors / "receipts-chain-0.1.jsonl"), "--keys", str(keys))
    assert legacy.returncode == 0
    assert "WARN v01_plaintext: 含明文意图或错误信息" in legacy.stderr
    report = json.loads(_run("verify", str(chain), "--keys", str(keys), "--json").stdout)
    expected = verify_jsonl(chain.read_text(encoding="utf-8"), json.loads(keys.read_text(encoding="utf-8")))
    assert report == expected.to_dict()
    assert "OK " not in _run("verify", str(chain), "--keys", str(keys), "--json").stdout
