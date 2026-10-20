from __future__ import annotations

import http.client
import json
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit, urlunsplit

from .errors import LedgerError, LedgerUnavailable

_URL_MESSAGE = "remote url must be an http(s) URL without a query or hash"
_USERINFO_MESSAGE = "remote url must not include userinfo"
_INSECURE_MESSAGE = (
    "remote url must use https, or http on loopback; pass allowInsecureHttp to allow plaintext http"
)
_RETRY_DELAYS = (0.2, 0.6)
_METHODS = {"request", "get_task", "claim", "complete", "fail", "revoke"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def normalize_remote_url(raw: str, allow_insecure_http: bool) -> str:
    try:
        parts = urlsplit(raw)
    except ValueError as error:
        raise LedgerError("invalid_request", _URL_MESSAGE, 400) from error
    host = parts.hostname
    if parts.scheme not in ("http", "https") or parts.query or parts.fragment or not host:
        raise LedgerError("invalid_request", _URL_MESSAGE, 400)
    if parts.username is not None or parts.password is not None:
        raise LedgerError("invalid_request", _USERINFO_MESSAGE, 400)
    loopback = host.lower() in ("127.0.0.1", "::1", "localhost")
    if parts.scheme == "http" and not loopback and not allow_insecure_http:
        raise LedgerError("invalid_request", _INSECURE_MESSAGE, 400)
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _plain(value: object) -> dict | None:
    return value if isinstance(value, dict) else None


def _retryable(method: str, params: dict) -> bool:
    if method == "get_task":
        return True
    key = params.get("idempotencyKey")
    return isinstance(key, str) and key != ""


class HttpClient:
    """Synchronous agent API client. Each call opens its own request."""

    def __init__(self, url: str, api_key: str, timeout: float = 30.0, allow_insecure_http: bool = False) -> None:
        self.url = normalize_remote_url(url, allow_insecure_http)
        self.api_key = api_key
        self.timeout = timeout

    def close(self) -> None:
        return None

    def call(self, method: str, params: dict, timeout: float | None = None) -> dict:
        if method == "sweep":
            return {}
        if method == "set_coverage_overlay":
            raise LedgerError(
                "remote_unsupported",
                "setCoverageOverlay is not available in remote mode; set coverage in the server policy",
                400,
            )
        if method not in _METHODS:
            raise LedgerError("remote_unsupported", f"{method} is not available in remote mode", 400)
        http_method, path, body = _route(method, params)
        limit = self.timeout if timeout is None else timeout
        retry = _retryable(method, params)
        attempt = 0
        while True:
            try:
                status, text = _exchange(self.url + path, http_method, body, self.api_key, limit)
            except (OSError, http.client.HTTPException) as error:
                if retry and attempt < len(_RETRY_DELAYS):
                    time.sleep(_RETRY_DELAYS[attempt])
                    attempt += 1
                    continue
                raise LedgerUnavailable(f"ActLedger server unreachable: {error}") from error
            if status in (502, 503, 504) and retry and attempt < len(_RETRY_DELAYS):
                time.sleep(_RETRY_DELAYS[attempt])
                attempt += 1
                continue
            return _interpret(status, text, method == "get_task")


def _route(method: str, params: dict) -> tuple[str, str, dict | None]:
    if method == "request":
        return "POST", "/v1/tasks", params
    task_id = params.get("id")
    if not isinstance(task_id, str) or task_id == "":
        raise LedgerError("invalid_request", "id must be a non-empty string", 400)
    path = f"/v1/tasks/{quote(task_id, safe='')}"
    if method == "get_task":
        return "GET", path, None
    body = {key: value for key, value in params.items() if key != "id"}
    return "POST", f"{path}/{method}", body


def _exchange(url: str, method: str, body: dict | None, api_key: str, timeout: float) -> tuple[int, str]:
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    data = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        data = json.dumps(
            {} if body is None else body,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = error.code
    text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    return status, text


def _interpret(status: int, text: str, get_task: bool) -> dict:
    if status in (500, 502, 503, 504):
        raise LedgerUnavailable(f"ActLedger server error {status}")
    if status == 401:
        raise LedgerError(
            "unauthorized",
            "ActLedger server rejected the API key; check ACTLEDGER_API_KEY",
            401,
        )
    if get_task and status == 404:
        return {"task": None}
    parsed: object | None
    if text.strip() == "":
        parsed = None
    else:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
    obj = _plain(parsed)
    if 200 <= status < 300:
        if obj is None:
            raise LedgerUnavailable("ActLedger server returned an invalid response")
        return obj
    if obj is not None and obj.get("code") == "ledger_unavailable":
        message = obj.get("message")
        raise LedgerUnavailable(message if isinstance(message, str) else "ledger unavailable")
    if (
        obj is not None
        and isinstance(obj.get("code"), str)
        and isinstance(obj.get("message"), str)
        and 400 <= status < 500
    ):
        reported = obj.get("status")
        details = obj.get("details")
        raise LedgerError(
            str(obj["code"]),
            str(obj["message"]),
            reported if isinstance(reported, int) else status,
            details if isinstance(details, dict) else {},
        )
    if 400 <= status < 500:
        raise LedgerError(f"http_{status}", text[:200], status)
    if obj is not None and isinstance(obj.get("code"), str) and isinstance(obj.get("message"), str):
        reported = obj.get("status")
        details = obj.get("details")
        raise LedgerError(
            str(obj["code"]),
            str(obj["message"]),
            reported if isinstance(reported, int) else status,
            details if isinstance(details, dict) else {},
        )
    raise LedgerError(f"http_{status}", text[:200], status)
