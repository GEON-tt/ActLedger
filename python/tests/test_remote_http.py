import json
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from actledger import (
    ContentMismatch,
    Ledger,
    LedgerError,
    LedgerUnavailable,
    approve_hint,
)
from actledger.ledger import Run
from actledger._http import HttpClient


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _go(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b""
        self.server.hits.append(  # type: ignore[attr-defined]
            {
                "method": self.command,
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body": raw.decode("utf-8"),
            }
        )
        status, payload, content_type = self.server.reply(self.command, self.path, raw)  # type: ignore[attr-defined]
        data = payload if isinstance(payload, bytes) else payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self._go()

    def do_POST(self) -> None:  # noqa: N802
        self._go()

    def log_message(self, fmt: str, *args: object) -> None:
        return


def serve(reply):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.hits = []  # type: ignore[attr-defined]
    httpd.reply = reply  # type: ignore[attr-defined]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]

    def close() -> None:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)

    return httpd, f"http://127.0.0.1:{port}", close


def json_reply(status: int, body: object):
    return status, json.dumps(body), "application/json"


def test_config_and_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(LedgerError) as missing:
        Ledger(mode="remote")
    assert missing.value.code == "invalid_request"
    assert "ACTLEDGER_URL" in str(missing.value)
    monkeypatch.setenv("ACTLEDGER_URL", "http://127.0.0.1:9/")
    monkeypatch.setenv("ACTLEDGER_API_KEY", "from-env")
    ledger = Ledger(mode="remote")
    assert ledger.console_url == "http://127.0.0.1:9"
    assert ledger.mode == "remote"
    assert ledger.dir is None
    ledger.close()
    with pytest.raises(LedgerError) as insecure:
        Ledger(mode="remote", url="http://example.com", api_key="k")
    assert "allowInsecureHttp" in str(insecure.value)
    allowed = Ledger(mode="remote", url="http://example.com", api_key="k", allow_insecure_http=True)
    assert allowed.console_url == "http://example.com"
    allowed.close()
    with pytest.raises(LedgerError) as overlay:
        Ledger(mode="remote", url="http://127.0.0.1:9", api_key="k", coverage_overlay=[{"action": "a"}])
    assert overlay.value.code == "invalid_request"
    with pytest.raises(LedgerError) as explicit_dir:
        Ledger(mode="remote", url="http://127.0.0.1:9", api_key="k", dir="/tmp/actledger-nope")
    assert "local-only" in str(explicit_dir.value)
    with pytest.raises(LedgerError) as bad_mode:
        Ledger(mode="elsewhere")
    assert str(bad_mode.value) == "pass mode='local' or mode='remote'"
    user = "alice"
    secret = "s3cret-token"
    with pytest.raises(LedgerError) as userinfo:
        Ledger(mode="remote", url=f"https://{user}:{secret}@example.com/actledger", api_key="k")
    assert userinfo.value.code == "invalid_request"
    assert str(userinfo.value) == "remote url must not include userinfo"
    assert secret not in str(userinfo.value)
    assert user not in str(userinfo.value)


def test_guard_poll_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    import actledger.ledger as ledger_mod

    seen: list[float] = []
    real = ledger_mod.ToolGate

    def spy(*args, **kwargs):
        seen.append(kwargs["poll_interval"])
        return real(*args, **kwargs)

    monkeypatch.setattr(ledger_mod, "ToolGate", spy)

    def decorate(ledger: Ledger) -> None:
        ledger.guard(
            action="email.read",
            principal=lambda kw: "u_1",
            payload=lambda kw: {"action": "email.read", "args": {}},
        )(lambda **_kw: None)

    remote = Ledger(mode="remote", url="http://127.0.0.1:9", api_key="k")
    decorate(remote)
    remote.mode = "local"
    decorate(remote)
    custom = Ledger(mode="remote", url="http://127.0.0.1:9", api_key="k", poll_interval=2.5)
    decorate(custom)
    remote.close()
    custom.close()
    assert seen == [1.0, 0.02, 2.5]


def test_oserror_while_reading_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    import actledger._http as http_mod

    class Body:
        status = 200

        def read(self):
            raise ssl.SSLError("handshake failed")

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class Opener:
        def open(self, request, timeout=None):
            return Body()

    monkeypatch.setattr(http_mod.urllib.request, "build_opener", lambda *args, **kwargs: Opener())
    client = HttpClient("http://127.0.0.1:9", "k")
    with pytest.raises(LedgerUnavailable) as error:
        client.call("complete", {"id": "tsk_1", "executedPayload": {"action": "email.read", "args": {}}})
    assert "unreachable" in str(error.value)
    client.close()

    class Refusing:
        def open(self, request, timeout=None):
            raise ssl.SSLError("tls refused")

    monkeypatch.setattr(http_mod.urllib.request, "build_opener", lambda *args, **kwargs: Refusing())
    again = HttpClient("https://127.0.0.1:9", "k")
    with pytest.raises(LedgerUnavailable) as refused:
        again.call("get_task", {"id": "tsk_1"})
    assert "unreachable" in str(refused.value)
    again.close()


def test_request_shape() -> None:
    def reply(method, path, raw):
        if method == "GET":
            return json_reply(200, {"task": {"id": "a/b", "state": "approved"}})
        return json_reply(200, {"task": {"id": "tsk_1", "state": "approved"}, "receipts": []})

    httpd, url, close = serve(reply)
    try:
        ledger = Ledger(mode="remote", url=url, api_key="secret")
        ledger.request(
            principal_id="u_1",
            action={"type": "email.send"},
            payload={"action": "email.send", "args": {}},
            idempotency_key="req-1",
        )
        ledger.get_task("a/b")
        ledger._claim("a/b")
        claim = httpd.hits[2]
        assert claim["path"] == "/v1/tasks/a%2Fb/claim"
        parsed = json.loads(claim["body"])
        assert "id" not in parsed
        assert "idempotencyKey" in parsed
        assert httpd.hits[0]["path"] == "/v1/tasks"
        assert httpd.hits[0]["headers"]["authorization"] == "Bearer secret"
        assert httpd.hits[0]["headers"]["content-type"] == "application/json"
        assert httpd.hits[0]["headers"]["accept"] == "application/json"
        assert json.loads(httpd.hits[0]["body"])["idempotencyKey"] == "req-1"
        assert httpd.hits[1]["path"] == "/v1/tasks/a%2Fb"
        assert httpd.hits[1]["method"] == "GET"
        ledger.close()
    finally:
        close()


def test_errors_and_content_mismatch() -> None:
    def reply(method, path, raw):
        if path.endswith("/complete"):
            return json_reply(
                409,
                {"code": "content_mismatch", "message": "payload drifted", "status": 409, "details": {"field": "to"}},
            )
        if path.endswith("/claim"):
            return json_reply(
                200,
                {
                    "task": {"id": "tsk_1", "state": "executing"},
                    "approvedPayload": {"action": "email.send", "args": {"to": "a@b.c"}},
                    "approvedPayloadHash": "sha256:abc",
                    "executionDeadline": "2026-01-01T00:00:00.000Z",
                    "receipt": {"hash": "sha256:r"},
                },
            )
        if method == "GET":
            return json_reply(404, {"code": "not_found", "message": "missing", "status": 404, "details": {}})
        if method == "POST" and path == "/v1/tasks":
            body = json.loads(raw.decode() or "{}")
            if body.get("idempotencyKey") == "conflict":
                return json_reply(
                    409,
                    {"code": "invalid_transition", "message": "nope", "status": 409, "details": {"from": "executed"}},
                )
            return json_reply(401, {"code": "unauthorized", "message": "nope", "status": 401, "details": {}})
        return json_reply(200, {"task": None})

    httpd, url, close = serve(reply)
    try:
        ledger = Ledger(mode="remote", url=url, api_key="k")
        assert ledger.get_task("missing") is None
        with pytest.raises(LedgerError) as denied:
            ledger.request(
                principal_id="u_1",
                action={"type": "email.read"},
                payload={"action": "email.read", "args": {}},
                read_only=True,
            )
        assert denied.value.code == "unauthorized"
        tolerant = Ledger(mode="remote", url=url, api_key="k", on_unavailable="allow_read_only")
        with pytest.raises(LedgerError) as still:
            tolerant.request(
                principal_id="u_1",
                action={"type": "email.read"},
                payload={"action": "email.read", "args": {}},
                read_only=True,
            )
        assert still.value.code == "unauthorized"
        with pytest.raises(LedgerError) as conflict:
            ledger.request(
                principal_id="u_1",
                action={"type": "email.send"},
                payload={"action": "email.send", "args": {}},
                idempotency_key="conflict",
            )
        assert conflict.value.code == "invalid_transition"
        assert conflict.value.status == 409
        assert conflict.value.details == {"from": "executed"}
        claimed = HttpClient(url, "k").call("claim", {"id": "tsk_1", "idempotencyKey": "c"})
        run = Run(ledger, claimed)
        with pytest.raises(ContentMismatch):
            run.complete(executed_payload={"action": "email.send", "args": {"to": "a@b.c"}})
        ledger.close()
        tolerant.close()
    finally:
        close()


def test_unavailable_and_degraded() -> None:
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    url = f"http://127.0.0.1:{port}"
    ledger = Ledger(mode="remote", url=url, api_key="k", call_timeout=0.5)
    with pytest.raises(LedgerUnavailable):
        ledger.get_task("tsk_1")
    degraded = Ledger(mode="remote", url=url, api_key="k", call_timeout=0.5, on_unavailable="allow_read_only")
    handle = degraded.request(
        principal_id="u_1",
        action={"type": "email.read"},
        payload={"action": "email.read", "args": {}},
        read_only=True,
    )
    assert handle.degraded is True
    ledger.close()
    degraded.close()


def test_retries() -> None:
    state = {"unavailable": 0, "errors": 0, "bare": 0}

    def reply(method, path, raw):
        if path == "/v1/tasks" and state["unavailable"] < 2:
            state["unavailable"] += 1
            return json_reply(503, {"code": "internal", "message": "down", "status": 503, "details": {}})
        body = json.loads(raw.decode() or "{}")
        return json_reply(200, {"task": {"id": "tsk_ok", "state": "approved"}, "receipts": [], "key": body.get("idempotencyKey")})

    httpd, url, close = serve(reply)
    try:
        ledger = Ledger(mode="remote", url=url, api_key="k")
        task = ledger.request(
            principal_id="u_1",
            action={"type": "email.read"},
            payload={"action": "email.read", "args": {}},
            idempotency_key="same-key",
        )
        assert task.id == "tsk_ok"
        assert len(httpd.hits) == 3
        assert [json.loads(hit["body"])["idempotencyKey"] for hit in httpd.hits] == ["same-key", "same-key", "same-key"]
        ledger.close()
    finally:
        close()

    def fatal(method, path, raw):
        state["errors"] += 1
        return json_reply(500, {"code": "internal", "message": "boom", "status": 500, "details": {}})

    httpd, url, close = serve(fatal)
    try:
        broken = Ledger(mode="remote", url=url, api_key="k")
        with pytest.raises(LedgerUnavailable) as error:
            broken.request(
                principal_id="u_1",
                action={"type": "email.read"},
                payload={"action": "email.read", "args": {}},
                idempotency_key="once",
            )
        assert "500" in str(error.value)
        assert state["errors"] == 1
        broken.close()
    finally:
        close()

    def once(method, path, raw):
        state["bare"] += 1
        return json_reply(503, {"code": "internal", "message": "down", "status": 503, "details": {}})

    httpd, url, close = serve(once)
    try:
        client = HttpClient(url, "k")
        with pytest.raises(LedgerUnavailable):
            client.call("complete", {"id": "tsk_1", "executedPayload": {"action": "email.read", "args": {}}})
        assert state["bare"] == 1
        client.close()
    finally:
        close()


def test_sweep_overlay_and_hints() -> None:
    def reply(method, path, raw):
        return json_reply(200, {"task": None})

    httpd, url, close = serve(reply)
    try:
        ledger = Ledger(mode="remote", url=url, api_key="k")
        ledger.sweep()
        assert httpd.hits == []
        with pytest.raises(LedgerError) as unsupported:
            ledger.set_coverage_overlay([])
        assert unsupported.value.code == "remote_unsupported"
        assert ledger.poll_interval == 1.0
        assert ledger.approve_hint("tsk_x") == (
            "Task tsk_x is waiting for approval. "
            "Approve or reject it in the ActLedger console: "
            f"{ledger.console_url}/tasks/tsk_x"
        )
        assert "cannot record" in ledger.approve_hint("tsk_x", {"minAssurance": "channel_verified"})
        ledger.close()
    finally:
        close()
    assert approve_hint("tsk_1", "/d") == (
        'Task tsk_1 is waiting for approval. '
        'Approve: actledger approve tsk_1 --dir /d  '
        'Reject: actledger reject tsk_1 --dir /d --note "<reason>"'
    )
