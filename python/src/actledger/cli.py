from __future__ import annotations

import json
import sys
from pathlib import Path

from .canonical import loads_strict
from .errors import LedgerError
from .secrets import parse_secrets_jsonl
from .verify import verify_jsonl

HELP = """actledger — receipt verifier

  python -m actledger verify <receipts.jsonl> --keys <keys.json> [--secrets file] [--json]
  python -m actledger help

"""


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except Exception:
            pass


def _verify_files(file: str, keys_path: str, secrets_path: str | None, as_json: bool) -> int:
    text = Path(file).read_text(encoding="utf-8")
    keys = loads_strict(Path(keys_path).read_text(encoding="utf-8"))
    if not isinstance(keys, dict):
        raise LedgerError("invalid_request", "keys must be an object", 400)
    secrets = parse_secrets_jsonl(Path(secrets_path).read_text(encoding="utf-8")) if secrets_path else None
    report = verify_jsonl(text, keys, secrets=secrets)
    if as_json:
        sys.stdout.write(json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n")
    elif report.ok:
        secret_stats = ""
        secrets_view = report.stats.get("secrets")
        if isinstance(secrets_view, dict):
            secret_stats = f" secrets={secrets_view['checked']}/{secrets_view['shredded']}/{secrets_view['missing']}"
        sys.stdout.write(
            f"OK {report.stats['count']} receipts  unknown={report.stats['unknown']} violations={report.stats['violations']}{secret_stats}\n"
        )
    else:
        failure = report.failure or {}
        seq = failure.get("seq")
        seq_text = "-" if seq is None else seq
        sys.stderr.write(f"FAIL seq={seq_text} step={failure.get('step')} {failure.get('reason')}\n")
    for warning in report.warnings:
        sys.stderr.write(f"WARN {warning['code']}: {warning['message']} ({warning['count']})\n")
    return 0 if report.ok else 1


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in ("--help", "-h"):
        args[0] = "help"
    command = args[0] if args else "help"
    as_json = False
    keys = None
    secrets = None
    positionals: list[str] = []
    index = 1
    try:
        while index < len(args):
            arg = args[index]
            if arg == "--json":
                as_json = True
            elif arg in ("--keys", "--secrets"):
                index += 1
                if index >= len(args):
                    raise LedgerError("invalid_request", f"missing value for {arg}", 400)
                if arg == "--keys":
                    keys = args[index]
                else:
                    secrets = args[index]
            elif arg in ("--help", "-h"):
                positionals.append("help")
            elif arg.startswith("-"):
                raise LedgerError("invalid_request", f"unknown flag {arg}", 400)
            else:
                positionals.append(arg)
            index += 1
    except LedgerError as error:
        sys.stderr.write(f"error: {error.code}: {error.message}\n")
        return 1
    if command == "help" or "help" in positionals:
        sys.stdout.write(HELP)
        return 0
    if command != "verify":
        sys.stderr.write(f"error: invalid_request: unknown command {command}\n")
        return 1
    if not positionals or not keys:
        sys.stderr.write("error: invalid_request: verify requires a file and --keys\n")
        return 1
    try:
        return _verify_files(positionals[0], keys, secrets, as_json)
    except LedgerError as error:
        sys.stderr.write(f"error: {error.code}: {error.message}\n")
        return 1


__all__ = ["main"]
