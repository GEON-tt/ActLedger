from __future__ import annotations

import json
import os
import queue
import shlex
import shutil
import subprocess
import threading
import weakref
from pathlib import Path

from .errors import LedgerError, LedgerUnavailable

_PROTOCOL = "actledger.rpc/1"
_STDERR_LIMIT = 64 * 1024


def _node_options(env: dict[str, str]) -> dict[str, str]:
    flag = "--disable-warning=ExperimentalWarning"
    current = env.get("NODE_OPTIONS", "")
    if flag not in current:
        env["NODE_OPTIONS"] = f"{current} {flag}".strip()
    return env


def resolve_command(explicit: list[str] | None) -> tuple[list[str], Path | None]:
    if explicit:
        return list(explicit), None
    configured = os.environ.get("ACTLEDGER_RPC_COMMAND")
    if configured:
        return shlex.split(configured), None
    here = Path(__file__).resolve()
    node = shutil.which("node")
    if node:
        for parent in here.parents:
            cli = parent / "packages" / "cli" / "src" / "main.ts"
            tsx = parent / "node_modules" / "tsx" / "dist" / "cli.mjs"
            if cli.is_file() and tsx.is_file():
                return [node, str(tsx), str(cli), "rpc"], parent
    found = shutil.which("actledger")
    if found:
        return [found, "rpc"], None
    raise LedgerUnavailable("actledger rpc command not found")


class RpcClient:
    def __init__(self, directory: str, command: list[str] | None = None, call_timeout: float = 30.0) -> None:
        self.call_timeout = call_timeout
        self.directory = os.path.abspath(directory)
        argv, cwd = resolve_command(command)
        argv = [*argv, "--dir", self.directory]
        env = _node_options(os.environ.copy())
        self._stderr = bytearray()
        self._stderr_lock = threading.Lock()
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._next_id = 1
        self._closed = False
        try:
            self.proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(cwd) if cwd is not None else None,
                env=env,
                bufsize=0,
            )
        except FileNotFoundError as error:
            raise LedgerUnavailable(f"actledger rpc executable not found: {error}") from error
        self._finalizer = weakref.finalize(self, _stop_process, self.proc)
        threading.Thread(target=self._drain_stderr, name="actledger-rpc-stderr", daemon=True).start()
        threading.Thread(target=self._drain_stdout, name="actledger-rpc-stdout", daemon=True).start()
        try:
            hello = self.call("hello", {})
        except Exception:
            self.close()
            raise
        protocol = hello.get("protocol") if isinstance(hello, dict) else None
        if protocol != _PROTOCOL:
            self.close()
            raise LedgerError("invalid_request", f"unsupported rpc protocol {protocol}", 400)

    def _tail(self) -> str:
        with self._stderr_lock:
            raw = bytes(self._stderr)
        text = raw.decode("utf-8", "replace").strip()
        return text

    def _unavailable(self, message: str) -> LedgerUnavailable:
        tail = self._tail()
        if tail:
            message = f"{message}\n{tail}"
        return LedgerUnavailable(message)

    def _drain_stderr(self) -> None:
        stream = self.proc.stderr
        if stream is None:
            return
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                with self._stderr_lock:
                    self._stderr.extend(chunk)
                    if len(self._stderr) > _STDERR_LIMIT:
                        del self._stderr[:-_STDERR_LIMIT]
        except Exception:
            return

    def _drain_stdout(self) -> None:
        stream = self.proc.stdout
        if stream is None:
            self._queue.put(None)
            return
        buf = b""
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self._queue.put(line.decode("utf-8"))
        except Exception as error:
            self._queue.put(error)
            return
        self._queue.put(None)

    def _raise_error(self, error: object) -> None:
        if not isinstance(error, dict):
            raise LedgerUnavailable(f"rpc error {error}")
        code = error.get("code")
        message = error.get("message")
        if not isinstance(message, str):
            message = str(message)
        if code == "ledger_unavailable":
            raise LedgerUnavailable(message)
        status = error.get("status")
        details = error.get("details")
        raise LedgerError(
            str(code),
            message,
            status if isinstance(status, int) else 400,
            details if isinstance(details, dict) else {},
        )

    def call(self, method: str, params: dict, timeout: float | None = None) -> dict:
        with self._lock:
            if self._closed:
                raise self._unavailable("rpc client is closed")
            if self.proc.poll() is not None:
                raise self._unavailable(f"rpc exited {self.proc.returncode}")
            request_id = self._next_id
            self._next_id += 1
            payload = json.dumps(
                {"id": request_id, "method": method, "params": params},
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8") + b"\n"
            stdin = self.proc.stdin
            if stdin is None:
                raise self._unavailable("rpc stdin is closed")
            try:
                stdin.write(payload)
                stdin.flush()
            except (BrokenPipeError, OSError) as error:
                try:
                    queued = self._queue.get(timeout=1)
                except queue.Empty:
                    queued = None
                if isinstance(queued, str):
                    return self._accept(queued, request_id)
                raise self._unavailable(f"rpc pipe closed: {error}") from error
            try:
                line = self._queue.get(timeout=self.call_timeout if timeout is None else timeout)
            except queue.Empty as error:
                raise self._unavailable("rpc call timed out") from error
            return self._accept(line, request_id)

    def _take_now(self) -> object:
        try:
            return self._queue.get_nowait()
        except queue.Empty:
            return None

    def _accept(self, line: object, request_id: int) -> dict:
        if line is None:
            raise self._unavailable(f"rpc exited {self.proc.poll() and self.proc.returncode}")
        if isinstance(line, Exception):
            raise self._unavailable(f"rpc read failed: {line}") from line
        if not isinstance(line, str):
            raise self._unavailable("rpc returned an empty response")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            raise self._unavailable(f"rpc returned invalid json: {error}") from error
        if not isinstance(response, dict):
            raise self._unavailable("rpc returned a non-object response")
        if response.get("id") != request_id:
            if response.get("id") is None and response.get("ok") is False:
                self._raise_error(response.get("error"))
            raise self._unavailable(f"rpc response id mismatch: {response.get('id')}")
        if response.get("ok") is not True:
            self._raise_error(response.get("error"))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            proc = self.proc
            if proc.poll() is None and proc.stdin is not None:
                try:
                    request_id = self._next_id
                    self._next_id += 1
                    payload = json.dumps(
                        {"id": request_id, "method": "shutdown", "params": {}},
                        separators=(",", ":"),
                    ).encode("utf-8") + b"\n"
                    proc.stdin.write(payload)
                    proc.stdin.flush()
                    proc.wait(timeout=5)
                except Exception:
                    if proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=2)
            if self._finalizer.alive:
                self._finalizer.detach()


def _stop_process(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except Exception:
            return
