from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import select
import shutil
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

from actledger import Ledger, LedgerError, LedgerUnavailable, ToolGate, verify_jsonl
from conftest import REPO_ROOT, SERVER_DIST, SERVER_SRC, TSX, _node_env

POLICY = """version: 1
defaults:
  unknown_action: require_approval
  approval: { channels: [cli, web], timeout: 1h, min_assurance: app_asserted }
actions:
  email.send: { level: write }
  db.delete: { level: delete }
"""

PASSWORD = "correct horse battery"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def totp_code(secret: str, at: float | None = None) -> str:
    pad = "=" * ((8 - (len(secret) % 8)) % 8)
    key = base64.b32decode(secret + pad, casefold=True)
    counter = int((time.time() if at is None else at) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{binary % 1_000_000:06d}"


def server_argv() -> list[str]:
    node = shutil.which("node")
    if not node:
        pytest.fail("node is required")
    if SERVER_DIST.is_file():
        return [node, str(SERVER_DIST)]
    return [node, str(TSX), str(SERVER_SRC)]


def run_server(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [*server_argv(), *args],
        cwd=REPO_ROOT,
        env=_node_env(),
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return result


def console_call(port: int, method: str, path: str, *, body: dict[str, str] | None = None, headers: dict[str, str] | None = None):
    data = urllib.parse.urlencode(body).encode("utf-8") if body is not None else None
    merged = {"Origin": f"http://127.0.0.1:{port}"}
    if body is not None:
        merged["Content-Type"] = "application/x-www-form-urlencoded"
    if headers:
        merged.update(headers)
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=merged, method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=10) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def field(html: str, name: str) -> str:
    match = re.search(rf'name="{name}" value="([^"]*)"', html)
    if not match:
        raise AssertionError(f"missing {name}")
    return match.group(1)


def approve(port: int, cookie: str, task_id: str) -> None:
    status, _headers, body = console_call(port, "GET", f"/tasks/{urllib.parse.quote(task_id, safe='')}", headers={"Cookie": cookie})
    if status != 200:
        raise AssertionError(f"task page {status}: {body[:300]!r}")
    html = body.decode("utf-8")
    posted, _headers, posted_body = console_call(
        port,
        "POST",
        f"/tasks/{urllib.parse.quote(task_id, safe='')}/approve",
        body={"csrf": field(html, "csrf"), "presented_hash": field(html, "presented_hash")},
        headers={"Cookie": cookie},
    )
    if posted != 303:
        raise AssertionError(f"approve {posted}: {posted_body[:300]!r}")


def wait_pending(port: int, cookie: str) -> str:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status, _headers, body = console_call(port, "GET", "/api/tasks?state=pending", headers={"Cookie": cookie})
        if status == 200:
            tasks = json.loads(body.decode("utf-8")).get("tasks") or []
            if tasks:
                return tasks[0]["id"]
        time.sleep(0.03)
    raise AssertionError("timed out waiting for a pending task")


@pytest.fixture
def remote_server(tmp_path):
    policy = tmp_path / "policy.yaml"
    policy.write_text(POLICY, encoding="utf-8")
    data = tmp_path / "data"
    run_server("init", "--data", str(data), "--policy", str(policy))
    user = json.loads(run_server("user", "add", "alice", "--principal", "u_1", "--password-stdin", "--no-qr", "--json", "--data", str(data), stdin=PASSWORD + "\n").stdout)
    agent = json.loads(run_server("agent-key", "create", "--agent", "py-agent", "--principal", "u_1", "--json", "--data", str(data)).stdout)
    other = json.loads(run_server("agent-key", "create", "--agent", "py-agent-2", "--principal", "u_2", "--json", "--data", str(data)).stdout)
    audit = json.loads(run_server("audit-key", "create", "--json", "--data", str(data)).stdout)
    proc = subprocess.Popen(
        [*server_argv(), "serve", "--data", str(data), "--port", "0", "--sweep-ms", "200"],
        cwd=REPO_ROOT,
        env=_node_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    assert proc.stderr is not None
    fd = proc.stderr.fileno()
    captured = bytearray()
    port = None
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        ready, _, _ = select.select([proc.stderr], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        captured += chunk
        match = re.search(rb"listening on http://127\.0\.0\.1:(\d+)", captured)
        if match:
            port = int(match.group(1))
            break
    if port is None:
        proc.kill()
        proc.wait(5)
        raise AssertionError(captured.decode("utf-8", "replace")[-4000:])

    def drain() -> None:
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return
            if not chunk:
                return

    threading.Thread(target=drain, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    ledger = Ledger(mode="remote", url=base, api_key=agent["key"])
    box = {
        "port": port,
        "base": base,
        "secret": user["secret"],
        "key": agent["key"],
        "other_key": other["key"],
        "audit_key": audit["key"],
        "ledger": ledger,
        "proc": proc,
    }
    try:
        yield box
    finally:
        ledger.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(5)


def _login(port: int, secret: str) -> str:
    status, headers, body = console_call(
        port,
        "POST",
        "/login",
        body={"username": "alice", "password": PASSWORD, "totp": totp_code(secret)},
    )
    raw_values = []
    if hasattr(headers, "get_all"):
        raw_values = headers.get_all("Set-Cookie") or []
    raw = "\n".join(raw_values) if raw_values else str(headers.get("Set-Cookie") or "")
    match = re.search(r"actledger_session=([^;]+)", raw)
    if status != 303 or not match:
        raise AssertionError(f"login {status}: {body[:400]!r}")
    return f"actledger_session={match.group(1)}"


@pytest.mark.node
def test_sync_wait_approve_export(remote_server) -> None:
    port = remote_server["port"]
    cookie = _login(port, remote_server["secret"])
    gate = ToolGate(
        remote_server["ledger"],
        principal="u_1",
        agent_id="py-agent",
        mode="wait",
        poll_interval=0.05,
        timeout=20,
    )
    box: dict = {}

    def worker() -> None:
        try:
            box["decision"] = gate.before("send_email", {"to": "a@b.c"})
        except Exception as error:  # noqa: BLE001
            box["error"] = error

    thread = threading.Thread(target=worker)
    thread.start()
    try:
        task_id = wait_pending(port, cookie)
        approve(port, cookie, task_id)
        thread.join(20)
    finally:
        if thread.is_alive():
            thread.join(1)
    assert "error" not in box, box.get("error")
    decision = box["decision"]
    assert decision.kind == "allow"
    receipt = gate.after(decision.run, result={"sent": True})
    assert receipt["hash"].startswith("sha256:")
    with urllib.request.urlopen(f"{remote_server['base']}/v1/keys", timeout=10) as response:
        keys = json.loads(response.read().decode("utf-8"))
    export = urllib.request.Request(
        f"{remote_server['base']}/v1/export",
        headers={"Authorization": f"Bearer {remote_server['audit_key']}"},
    )
    with urllib.request.urlopen(export, timeout=10) as response:
        text = response.read().decode("utf-8")
    assert verify_jsonl(text, keys).ok
    approved = []
    for line in text.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        transition = item.get("transition") or {}
        if transition.get("to") == "approved":
            approved.append(item)
    assert approved[-1]["body"]["approval"]["channel"] == "web"


@pytest.mark.node
def test_async_defer_resume(remote_server) -> None:
    port = remote_server["port"]
    cookie = _login(port, remote_server["secret"])

    async def run() -> None:
        gate = ToolGate(remote_server["ledger"], principal="u_1", agent_id="py-agent", mode="defer")
        decision = await gate.async_before("send_email", {"to": "a@b.c"})
        assert decision.kind == "pending"
        assert f"{remote_server['base']}/tasks/{decision.task_id}" in decision.approve_hint
        approve(port, cookie, decision.task_id)
        resumed = await gate.async_resume(decision.task_id)
        assert resumed.kind == "allow"
        receipt = await gate.async_after(resumed.run, result={"sent": True})
        assert receipt["hash"].startswith("sha256:")

    asyncio.run(run())


@pytest.mark.node
def test_other_principal_is_forbidden(remote_server) -> None:
    other = Ledger(mode="remote", url=remote_server["base"], api_key=remote_server["other_key"])
    try:
        with pytest.raises(LedgerError) as error:
            other.request(
                principal_id="u_1",
                action={"type": "email.send"},
                payload={"action": "email.send", "args": {}},
            )
        assert error.value.code == "principal_not_allowed"
        assert error.value.status == 403
    finally:
        other.close()


@pytest.mark.node
def test_stopped_server_is_unavailable(remote_server) -> None:
    proc = remote_server["proc"]
    proc.terminate()
    proc.wait(5)
    with pytest.raises(LedgerUnavailable):
        remote_server["ledger"].get_task("tsk_missing")
