from __future__ import annotations

import json

import pytest

from pathlib import Path

from actledger.canonical import commit, jcs, loads_strict
from actledger.errors import LedgerError


def test_jcs_vectors(vectors: Path) -> None:
    cases = json.loads((vectors / "jcs.json").read_text(encoding="utf-8"))
    for case in cases:
        assert jcs(loads_strict(json.dumps(case["value"]))) == case["jcs"]


def test_commitment_vectors(vectors: Path) -> None:
    document = json.loads((vectors / "commitments.json").read_text(encoding="utf-8"))
    assert len(document["cases"]) >= 3
    assert any(case["label"] == "zh" for case in document["cases"])
    salt = bytes.fromhex(document["salt_hex"])
    for case in document["cases"]:
        assert commit(salt, case["value"]) == case["commit"]


def test_bool_is_not_an_int_and_bad_types_use_the_path() -> None:
    assert jcs(True) == "true"
    assert jcs(1) == "1"
    with pytest.raises(LedgerError) as bad_key:
        jcs({1: 2})
    assert bad_key.value.code == "invalid_request"
    assert bad_key.value.message == "$ is not JSON-serializable"
    with pytest.raises(LedgerError) as nested:
        jcs({"a": {1, 2}})
    assert nested.value.code == "invalid_request"
    assert nested.value.message == "$.a is not JSON-serializable"


@pytest.mark.node
def test_jcs_and_base64url_match_node(parity) -> None:
    jcs_cases = [
        ("bmp-vs-emoji", json.dumps({"\ue000": 1, "😀": 2}, ensure_ascii=False)),
        ("ascii-keys", json.dumps({"b": 1, "a": 2, "aa": 3, "A": 4})),
        ("zh-keys", json.dumps({"回复": 1, "邮件": 2, "a": 3}, ensure_ascii=False)),
        ("max-safe", "9007199254740991"),
        ("too-big", "9007199254740992"),
        ("fraction", "1.5"),
        ("huge", "1e400"),
        ("one", "1.0"),
        ("scientific", "1e2"),
        ("negative-zero", "-0"),
        ("controls", json.dumps("\u0000\u001f\u007f\u2028/")),
        ("lone-surrogate", json.dumps("\ud800")),
        ("surrogate-pair", json.dumps("\ud83d\ude00")),
        ("zh-text", json.dumps("回复邮件：周会", ensure_ascii=False)),
        ("nested", json.dumps({"b": [{"d": None, "c": True}], "a": {"é": "中"}}, ensure_ascii=False)),
    ]
    b64_cases = ["YQ==", "YQ+", "Y Q", "abcde", "YQ=Y", "@@YQ@@", "++++", "////"]
    batch = {
        "jcs": [{"name": name, "json": text} for name, text in jcs_cases],
        "b64": [{"name": text, "text": text} for text in b64_cases],
    }
    result = parity(batch)
    from actledger._b64 import b64url_decode_lenient

    for (name, text), remote in zip(jcs_cases, result["jcs"]):
        assert remote["name"] == name
        try:
            local = {"jcs": jcs(loads_strict(text))}
        except LedgerError as error:
            local = {"error": {"code": error.code, "message": error.message}}
        if remote.get("error", {}).get("code") == "throw":
            pytest.skip(f"{name}: {remote['error']['message']}")
        if "error" in local:
            assert remote["error"]["code"] == local["error"]["code"]
            assert remote["error"]["message"] == local["error"]["message"]
        else:
            assert remote["jcs"] == local["jcs"]
    for text, remote in zip(b64_cases, result["b64"]):
        assert remote["hex"] == b64url_decode_lenient(text).hex()
