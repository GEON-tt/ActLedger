from __future__ import annotations

from .canonical import GENESIS_HASH, commit, is_safe_int, loads_strict
from ._b64 import b64url_decode_lenient
from .crypto import verify_ed25519
from .errors import LedgerError
from .payload import compare_with_drift, payload_hash
from .receipts import receipt_hash, unsigned_receipt
from .secrets import (
    COMMIT_RE,
    ERROR_CODE_RE,
    RECEIPT_V01,
    RECEIPT_V02,
    SHA_RE,
    payload_commit,
    reason_allowed,
    text_commit,
)
from .states import can_transition, is_state, is_terminal

STEPS = (
    "structure",
    "hash",
    "signature",
    "chain",
    "version",
    "plaintext",
    "commitments",
    "state_machine",
    "semantics",
    "secrets",
)

_COMMIT_KEYS = {
    "payload_hash",
    "approved_payload_hash",
    "executed_hash",
    "presented_hash",
    "edited_payload_hash",
    "intent_commit",
    "message_commit",
    "note_commit",
    "description_commit",
}


def assurance_rank(assurance: str) -> int:
    return {"policy": 0, "app_asserted": 1, "channel_verified": 2, "user_signed": 3}.get(assurance, -1)


def is_user_assurance(value: object) -> bool:
    return value in ("app_asserted", "channel_verified", "user_signed")


class VerifyReport:
    def __init__(self, ok: bool, warnings: list[dict], stats: dict, failure: dict | None = None) -> None:
        self.ok = ok
        self.warnings = warnings
        self.stats = stats
        self.failure = failure

    def to_dict(self) -> dict:
        if self.ok:
            return {"ok": True, "warnings": self.warnings, "stats": self.stats}
        return {"ok": False, "failure": self.failure, "warnings": self.warnings, "stats": self.stats}


def _empty_stats() -> dict:
    return {"count": 0, "byMode": {}, "byAssurance": {}, "byVersion": {}, "unknown": 0, "violations": 0}


def _fail(receipt: dict | None, step: str, reason: str) -> dict:
    failure: dict = {}
    if isinstance(receipt, dict):
        if "seq" in receipt:
            failure["seq"] = receipt["seq"]
        if "id" in receipt:
            failure["id"] = receipt["id"]
    failure["step"] = step
    failure["reason"] = reason
    return failure


def _is_record(value: object) -> bool:
    return isinstance(value, dict)


def _seq_key(receipt: object) -> tuple[int, int]:
    if isinstance(receipt, dict) and "seq" in receipt and is_safe_int(receipt["seq"]):
        return (0, receipt["seq"])
    return (1, 0)


def _sort_by_seq(receipts: list) -> list:
    return sorted(receipts, key=_seq_key)


def _check_structure(receipt: object) -> str | None:
    if not isinstance(receipt, dict):
        return "unsupported receipt version"
    if receipt.get("v") not in (RECEIPT_V01, RECEIPT_V02):
        return "unsupported receipt version"
    if not isinstance(receipt.get("id"), str) or not isinstance(receipt.get("app_id"), str):
        return "missing id or app_id"
    seq = receipt.get("seq")
    if not is_safe_int(seq) or seq < 1:
        return "seq must be a positive integer"
    if not isinstance(receipt.get("prev_hash"), str) or not isinstance(receipt.get("hash"), str):
        return "missing hash"
    if receipt.get("v") == RECEIPT_V02 and (
        SHA_RE.fullmatch(receipt["prev_hash"]) is None or SHA_RE.fullmatch(receipt["hash"]) is None
    ):
        return "hash must be sha256"
    if "task_id" not in receipt or (receipt["task_id"] is not None and not isinstance(receipt["task_id"], str)):
        return "task_id must be a string or null"
    if "transition" not in receipt or receipt["transition"] is not None:
        transition = receipt.get("transition")
        if not isinstance(transition, dict) or "from" not in transition or not isinstance(transition.get("to"), str):
            return "transition must be {from, to}"
        origin = transition["from"]
        if origin is not None and not isinstance(origin, str):
            return "transition must be {from, to}"
    actor = receipt.get("actor")
    if not isinstance(actor, dict) or not isinstance(actor.get("type"), str) or not isinstance(actor.get("id"), str):
        return "actor is required"
    if not isinstance(receipt.get("body"), dict) or not isinstance(receipt.get("evidence"), list):
        return "body and evidence are required"
    if not isinstance(receipt.get("issued_at"), str):
        return "issued_at is required"
    sig = receipt.get("sig")
    if (
        not isinstance(sig, dict)
        or sig.get("alg") != "Ed25519"
        or not isinstance(sig.get("kid"), str)
        or not isinstance(sig.get("value"), str)
    ):
        return "sig must be Ed25519"
    return None


def _key_valid(keys: dict, receipt: dict) -> str | None:
    kid = receipt["sig"]["kid"]
    key = next((item for item in keys.get("keys", []) if isinstance(item, dict) and item.get("kid") == kid), None)
    if key is None:
        return f"unknown kid {kid}"
    retired = key.get("retired_at")
    if retired and receipt["issued_at"] > retired:
        return f"kid {key.get('kid')} was retired at {retired}"
    if not verify_ed25519(key.get("public_key", ""), receipt["hash"], receipt["sig"]["value"]):
        return "signature mismatch"
    return None


def _bump(bucket: dict, key: object) -> None:
    if not isinstance(key, str):
        return
    bucket[key] = bucket.get(key, 0) + 1


def _collect_stats(receipts: list) -> dict:
    stats = _empty_stats()
    stats["count"] = len(receipts)
    for receipt in receipts:
        if not isinstance(receipt, dict):
            continue
        version = receipt.get("v")
        if isinstance(version, str):
            _bump(stats["byVersion"], version)
        body = receipt.get("body") if isinstance(receipt.get("body"), dict) else {}
        integration = body.get("integration")
        if isinstance(integration, dict) and isinstance(integration.get("mode"), str):
            _bump(stats["byMode"], integration["mode"])
        approval = body.get("approval")
        if isinstance(approval, dict) and isinstance(approval.get("assurance"), str):
            _bump(stats["byAssurance"], approval["assurance"])
        transition = receipt.get("transition")
        if isinstance(transition, dict) and transition.get("to") == "unknown":
            stats["unknown"] += 1
        if isinstance(body, dict) and body.get("kind") == "violation":
            stats["violations"] += 1
    return stats


def _has_v01_plaintext(receipt: dict) -> bool:
    body = receipt.get("body")
    if not isinstance(body, dict):
        return False
    initiator = body.get("initiator")
    if isinstance(initiator, dict) and "intent" in initiator:
        return True
    error = body.get("error")
    if isinstance(error, dict) and "message" in error:
        return True
    if "note" in body:
        return True
    if "reason" in body and isinstance(body.get("reason"), str):
        transition = receipt.get("transition")
        to = transition.get("to") if isinstance(transition, dict) else ""
        if not isinstance(to, str):
            to = ""
        if not reason_allowed(to, body["reason"]):
            return True
    return False


def _collect_warnings(receipts: list) -> list[dict]:
    count = 0
    for receipt in receipts:
        if isinstance(receipt, dict) and receipt.get("v") == RECEIPT_V01 and _has_v01_plaintext(receipt):
            count += 1
    if count == 0:
        return []
    return [{"code": "v01_plaintext", "message": "含明文意图或错误信息", "count": count}]


def _check_versions(receipts: list[dict]) -> dict | None:
    seen: dict[str, str] = {}
    for receipt in receipts:
        task_id = receipt.get("task_id")
        if not task_id or not isinstance(task_id, str):
            continue
        previous = seen.get(task_id)
        version = receipt.get("v")
        if previous and previous != version:
            return _fail(receipt, "version", f"task {task_id} mixes receipt versions")
        if isinstance(version, str):
            seen[task_id] = version
    return None


def _check_plaintext(receipt: dict) -> str | None:
    if receipt.get("v") != RECEIPT_V02:
        return None
    body = receipt.get("body")
    if not isinstance(body, dict):
        return None
    if "initiator" in body and not isinstance(body.get("initiator"), dict):
        return "initiator must be an object"
    if "approval" in body and not isinstance(body.get("approval"), dict):
        return "approval must be an object"
    if "error" in body and not isinstance(body.get("error"), dict):
        return "error must be an object"
    initiator = body.get("initiator")
    if isinstance(initiator, dict) and "intent" in initiator:
        return "initiator.intent is plaintext"
    if "note" in body:
        return "note is plaintext"
    if "description" in body:
        return "description is plaintext"
    if "result" in body:
        return "result is plaintext"
    approval = body.get("approval")
    if isinstance(approval, dict) and "note" in approval:
        return "approval.note is plaintext"
    if "reason" in body:
        transition = receipt.get("transition")
        to = transition.get("to") if isinstance(transition, dict) else ""
        if not isinstance(to, str):
            to = ""
        if not isinstance(body.get("reason"), str) or not reason_allowed(to, body["reason"]):
            return "reason is not an enumerated value"
    error = body.get("error")
    if isinstance(error, dict):
        if "message" in error:
            return "error.message is plaintext"
        for key in error:
            if key not in ("code", "message_commit", "retryable"):
                return f"error.{key} is not allowed"
        if not isinstance(error.get("code"), str) or ERROR_CODE_RE.fullmatch(error["code"]) is None:
            return "error.code is invalid"
        if not isinstance(error.get("message_commit"), str):
            return "error.message_commit is required"
        if "retryable" in error and not isinstance(error.get("retryable"), bool):
            return "error.retryable must be boolean"
    return None


def _commit_field(value: object, where: str) -> str | None:
    if not isinstance(value, str) or COMMIT_RE.fullmatch(value) is None:
        return f"{where} is not an hmac-sha256 commitment"
    return None


def _check_commit_fields(body: dict) -> str | None:
    for key, value in body.items():
        if key not in _COMMIT_KEYS or value is None:
            continue
        bad = _commit_field(value, key)
        if bad:
            return bad
    approval = body.get("approval")
    if isinstance(approval, dict):
        for key, value in approval.items():
            if key not in _COMMIT_KEYS or value is None:
                continue
            bad = _commit_field(value, f"approval.{key}")
            if bad:
                return bad
    initiator = body.get("initiator")
    if isinstance(initiator, dict) and "intent_commit" in initiator:
        bad = _commit_field(initiator.get("intent_commit"), "initiator.intent_commit")
        if bad:
            return bad
    error = body.get("error")
    if isinstance(error, dict) and "message_commit" in error:
        bad = _commit_field(error.get("message_commit"), "error.message_commit")
        if bad:
            return bad
    proofs = body.get("external_proofs")
    if isinstance(proofs, list):
        for proof in proofs:
            if not isinstance(proof, dict):
                return "external_proofs commit is not an hmac-sha256 commitment"
            bad = _commit_field(proof.get("commit"), "external_proofs.commit")
            if bad:
                return bad
    return None


def _drift_empty(value: object) -> bool:
    return value is None or (isinstance(value, list) and len(value) == 0)


def _check_commitments(receipts: list[dict]) -> dict | None:
    by_task: dict[str, list[dict]] = {}
    for receipt in receipts:
        if receipt.get("v") != RECEIPT_V02 or not receipt.get("task_id"):
            continue
        task_id = receipt["task_id"]
        if not isinstance(task_id, str):
            continue
        by_task.setdefault(task_id, []).append(receipt)
    for task_id, group in by_task.items():
        group = sorted(group, key=_seq_key)
        payload_seen: str | None = None
        payload_ready = False
        intent_seen: str | None = None
        saw_intent = False
        approved_at_approval: str | None = None
        approved_ready = False
        for receipt in group:
            body = receipt.get("body")
            if not isinstance(body, dict):
                body = {}
            fields = _check_commit_fields(body)
            if fields:
                return _fail(receipt, "commitments", fields)
            payload_value = body.get("payload_hash")
            if isinstance(payload_value, str):
                if not payload_ready:
                    payload_seen = payload_value
                    payload_ready = True
                elif payload_value != payload_seen:
                    return _fail(receipt, "commitments", f"task {task_id} payload_hash changed")
                evidence = receipt.get("evidence")
                if isinstance(evidence, list):
                    for item in evidence:
                        if isinstance(item, dict) and item.get("type") == "payload" and item.get("sha256") != payload_value:
                            return _fail(receipt, "commitments", "payload evidence does not match payload_hash")
            initiator = body.get("initiator")
            if isinstance(initiator, dict):
                present = "intent_commit" in initiator
                value = initiator.get("intent_commit") if present and isinstance(initiator.get("intent_commit"), str) else None
                if not saw_intent:
                    saw_intent = True
                    intent_seen = value
                elif intent_seen != value:
                    return _fail(receipt, "commitments", f"task {task_id} intent_commit changed")
            approval = body.get("approval")
            if isinstance(approval, dict):
                presented = approval.get("presented_hash")
                if isinstance(presented, str) and presented != body.get("payload_hash"):
                    return _fail(receipt, "commitments", "presented_hash does not match payload_hash")
                approved_hash = body.get("approved_payload_hash")
                if isinstance(approved_hash, str):
                    edited = approval.get("edited_payload_hash")
                    expected = edited if isinstance(edited, str) else body.get("payload_hash")
                    if approved_hash != expected:
                        return _fail(receipt, "commitments", "approved_payload_hash does not match the approval")
            transition = receipt.get("transition")
            if (
                isinstance(transition, dict)
                and transition.get("to") == "approved"
                and isinstance(body.get("approved_payload_hash"), str)
            ):
                approved_at_approval = body["approved_payload_hash"]
                approved_ready = True
        for receipt in group:
            body = receipt.get("body") if isinstance(receipt.get("body"), dict) else {}
            transition = receipt.get("transition")
            to = transition.get("to") if isinstance(transition, dict) else None
            approved = body.get("approved_payload_hash")
            if (
                to in ("executing", "executed", "failed")
                and isinstance(approved, str)
                and approved_ready
                and approved != approved_at_approval
            ):
                return _fail(receipt, "commitments", "approved_payload_hash does not match the approval")
            executed_hash = body.get("executed_hash")
            if isinstance(executed_hash, str) and isinstance(approved, str):
                same = executed_hash == approved
                empty = _drift_empty(body.get("drift_applied"))
                if same and (body.get("content_match") is not True or not empty):
                    return _fail(receipt, "commitments", "executed_hash matches approved_payload_hash but drift is recorded")
                if body.get("content_match") is True and not same and empty:
                    return _fail(receipt, "commitments", "content_match requires drift_applied when hashes differ")
    for receipt in receipts:
        if receipt.get("v") != RECEIPT_V02:
            continue
        body = receipt.get("body")
        if not isinstance(body, dict):
            continue
        fields = _check_commit_fields(body)
        if fields:
            return _fail(receipt, "commitments", fields)
    return None


def _check_state_machines(receipts: list[dict]) -> dict | None:
    by_task: dict[str, list[dict]] = {}
    for receipt in receipts:
        if not receipt.get("task_id") or not receipt.get("transition"):
            continue
        task_id = receipt["task_id"]
        if not isinstance(task_id, str):
            continue
        by_task.setdefault(task_id, []).append(receipt)
    for task_id, group in by_task.items():
        group = sorted(group, key=_seq_key)
        first = group[0]
        transition = first.get("transition") if isinstance(first.get("transition"), dict) else None
        origin = transition.get("from") if transition else None
        destination = transition.get("to") if transition else None
        if origin is not None or destination != "prepared":
            return _fail(first, "state_machine", f"task {task_id} does not start at prepared")
        current = "prepared"
        claims = 0
        terminals = 0
        for receipt in group[1:]:
            step = receipt.get("transition") if isinstance(receipt.get("transition"), dict) else {}
            start = step.get("from")
            end = step.get("to")
            if not isinstance(start, str) or not isinstance(end, str) or not is_state(start) or not is_state(end):
                return _fail(receipt, "state_machine", "transition endpoints must be states")
            if start != current:
                return _fail(receipt, "state_machine", f"task {task_id} jumps from {current} but receipt says {start}")
            if is_terminal(current):
                return _fail(receipt, "state_machine", f"task {task_id} moved after terminal state {current}")
            if not can_transition(start, end):
                return _fail(receipt, "state_machine", f"illegal transition {start} -> {end}")
            if start == "approved" and end == "executing":
                claims += 1
            if is_terminal(end):
                terminals += 1
            current = end
        if claims > 1:
            return _fail(group[0], "state_machine", f"task {task_id} was claimed more than once")
        if terminals > 1:
            return _fail(group[0], "state_machine", f"task {task_id} has more than one terminal state")
    return None


def _check_semantics(receipts: list[dict]) -> dict | None:
    by_task: dict[str, list[dict]] = {}
    for receipt in receipts:
        task_id = receipt.get("task_id")
        if not task_id or not isinstance(task_id, str):
            continue
        by_task.setdefault(task_id, []).append(receipt)
    for group in by_task.values():
        group = sorted(group, key=_seq_key)
        executed = next((item for item in group if isinstance(item.get("transition"), dict) and item["transition"].get("to") == "executed"), None)
        executing = next((item for item in group if isinstance(item.get("transition"), dict) and item["transition"].get("to") == "executing"), None)
        approved = next((item for item in group if isinstance(item.get("transition"), dict) and item["transition"].get("to") == "approved"), None)
        if executed is not None:
            body = executed.get("body") if isinstance(executed.get("body"), dict) else {}
            match = body.get("content_match") is True
            marked = body.get("mismatch") is True
            if not match and not marked:
                return _fail(executed, "semantics", "executed receipt is neither content_match nor mismatch")
        approved_body = None
        if approved is not None and isinstance(approved.get("body"), dict) and isinstance(approved["body"].get("approval"), dict):
            approved_body = approved["body"]["approval"]
        if approved is not None and approved_body is not None:
            assurance = approved_body.get("assurance")
            approver = approved_body.get("approver") if isinstance(approved_body.get("approver"), str) else ""
            policy = approved["body"].get("policy") if isinstance(approved.get("body"), dict) else None
            policy = policy if isinstance(policy, dict) else None
            minimum = policy.get("min_assurance") if policy else None
            has_min = isinstance(minimum, str)
            policy_allow = (not has_min) and approver.startswith("policy:")
            if has_min:
                got = assurance_rank(assurance) if isinstance(assurance, str) else -1
                need = assurance_rank(minimum)
                if not is_user_assurance(assurance) or need < 1 or got < need:
                    shown = _js_string(assurance, missing="assurance" not in approved_body)
                    return _fail(approved, "semantics", f"assurance {shown} is below required {minimum}")
            auth = approved_body.get("auth") if isinstance(approved_body.get("auth"), dict) else None
            step_up = policy.get("step_up") if policy else None
            if isinstance(step_up, str) and not approver.startswith("policy:"):
                if auth is None or auth.get("step_up") != step_up or auth.get("simulated") is not True:
                    return _fail(approved, "semantics", "step-up does not match the policy requirement")
            if auth is not None and "step_up" in auth and auth.get("step_up") is not None and auth.get("simulated") is not True:
                return _fail(approved, "semantics", "step-up is simulated until a channel authenticator exists")
            if not policy_allow and assurance != "policy":
                decided_at = approved_body.get("decided_at")
                if not isinstance(assurance, str) or not isinstance(decided_at, str):
                    return _fail(approved, "semantics", "approval is missing assurance or decided_at")
                if executing is not None and isinstance(executing.get("issued_at"), str) and decided_at > executing["issued_at"]:
                    return _fail(executing, "semantics", "approval is later than execution")
    return None


def _same_drift(actual: object, expected: list[str]) -> bool:
    return (
        isinstance(actual, list)
        and len(actual) == len(expected)
        and all(actual[index] == expected[index] for index in range(len(expected)))
    )


def _as_payload(value: object) -> dict | None:
    if not isinstance(value, dict) or not isinstance(value.get("action"), str) or not isinstance(value.get("args"), dict):
        return None
    return value


def _find_proof(proofs: object, index: int) -> dict | None:
    if not isinstance(proofs, list):
        return None
    for candidate in proofs:
        if isinstance(candidate, dict) and candidate.get("index") == index:
            return candidate
    if 0 <= index < len(proofs) and isinstance(proofs[index], dict):
        return proofs[index]
    return None


def _check_proof_secrets(receipt: dict, proofs: object) -> str | None:
    body = receipt.get("body") if isinstance(receipt.get("body"), dict) else {}
    ext = body.get("external_proofs")
    if not isinstance(ext, list) or len(ext) == 0:
        return None
    for index, item in enumerate(ext):
        proof = _find_proof(proofs, index)
        if not isinstance(item, dict) or proof is None:
            return "missing proof secret"
        mac = commit(b64url_decode_lenient(str(proof.get("salt", ""))), proof.get("value"))
        if mac != item.get("commit"):
            return "proof commitment does not match the secret"
        if isinstance(proof.get("type"), str) and proof.get("type") != item.get("type"):
            return "proof commitment does not match the secret"
    return None


def _check_task_secrets(receipts: list[dict], entry: dict) -> dict | None:
    if entry.get("payload_salt") is None:
        payload = _as_payload(entry.get("payload"))
        if payload is None:
            return _fail(receipts[0], "secrets", "legacy secret is missing a payload")
        expected_payload = payload_hash(payload)
        approved_source = _as_payload(entry.get("approved_payload")) or payload
        expected_approved = payload_hash(approved_source)
        executed_source = _as_payload(entry.get("executed_payload"))
        for receipt in receipts:
            body = receipt.get("body") if isinstance(receipt.get("body"), dict) else {}
            if isinstance(body.get("payload_hash"), str) and body["payload_hash"] != expected_payload:
                return _fail(receipt, "secrets", "payload_hash does not match the secret")
            if isinstance(body.get("approved_payload_hash"), str) and body["approved_payload_hash"] != expected_approved:
                return _fail(receipt, "secrets", "approved_payload_hash does not match the secret")
            if executed_source and isinstance(body.get("executed_hash"), str) and body["executed_hash"] != payload_hash(executed_source):
                return _fail(receipt, "secrets", "executed_hash does not match the secret")
            if executed_source and "content_match" in body:
                comparison = compare_with_drift(approved_source, executed_source)
                if body.get("content_match") is not comparison.match or not _same_drift(body.get("drift_applied"), comparison.drift_applied):
                    return _fail(receipt, "secrets", "content_match does not match the secret payloads")
            proof_error = _check_proof_secrets(receipt, entry.get("proofs"))
            if proof_error:
                return _fail(receipt, "secrets", proof_error)
        return None
    salt = b64url_decode_lenient(str(entry.get("payload_salt")))
    payload = _as_payload(entry.get("payload"))
    if payload is None:
        return _fail(receipts[0], "secrets", "secret is missing a payload")
    expected_payload = payload_commit(salt, payload)
    approved_source = _as_payload(entry.get("approved_payload")) or payload
    expected_approved = payload_commit(salt, approved_source)
    executed_source = _as_payload(entry.get("executed_payload"))
    for receipt in receipts:
        body = receipt.get("body") if isinstance(receipt.get("body"), dict) else {}
        if isinstance(body.get("payload_hash"), str) and body["payload_hash"] != expected_payload:
            return _fail(receipt, "secrets", "payload_hash does not match the secret")
        if isinstance(body.get("approved_payload_hash"), str) and body["approved_payload_hash"] != expected_approved:
            return _fail(receipt, "secrets", "approved_payload_hash does not match the secret")
        initiator = body.get("initiator")
        if isinstance(initiator, dict) and isinstance(initiator.get("intent_commit"), str):
            intent = entry.get("intent")
            if not isinstance(intent, str) or text_commit(salt, intent) != initiator["intent_commit"]:
                return _fail(receipt, "secrets", "intent_commit does not match the secret")
        if isinstance(body.get("executed_hash"), str):
            if executed_source is None or body["executed_hash"] != payload_commit(salt, executed_source):
                return _fail(receipt, "secrets", "executed_hash does not match the secret")
        if executed_source and "content_match" in body:
            comparison = compare_with_drift(approved_source, executed_source)
            if body.get("content_match") is not comparison.match or not _same_drift(body.get("drift_applied"), comparison.drift_applied):
                return _fail(receipt, "secrets", "content_match does not match the secret payloads")
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("message_commit"), str):
            secret_error = entry.get("error")
            if (
                not isinstance(secret_error, dict)
                or text_commit(salt, secret_error.get("message")) != error["message_commit"]
                or error.get("code") != secret_error.get("code")
            ):
                return _fail(receipt, "secrets", "error commitment does not match the secret")
        if isinstance(body.get("note_commit"), str):
            transition = receipt.get("transition")
            to = transition.get("to") if isinstance(transition, dict) else None
            notes = entry.get("notes") if isinstance(entry.get("notes"), dict) else {}
            if to == "rejected":
                note = notes.get("reject")
            elif to == "revoked":
                note = notes.get("revoke")
            elif to == "failed" or body.get("reconciled") is True:
                note = notes.get("reconcile")
            else:
                note = None
            if not isinstance(note, str) or text_commit(salt, note) != body["note_commit"]:
                return _fail(receipt, "secrets", "note_commit does not match the secret")
        proof_error = _check_proof_secrets(receipt, entry.get("proofs"))
        if proof_error:
            return _fail(receipt, "secrets", proof_error)
    return None


def _check_secrets(receipts: list[dict], secrets: list[dict]) -> dict:
    stats = {"checked": 0, "shredded": 0, "missing": 0}
    by_task: dict[str, list[dict]] = {}
    for receipt in receipts:
        task_id = receipt.get("task_id")
        if not task_id or not isinstance(task_id, str):
            continue
        by_task.setdefault(task_id, []).append(receipt)
    secret_by_task: dict[str, dict] = {}
    for entry in secrets:
        if isinstance(entry, dict) and entry.get("kind") == "task" and isinstance(entry.get("task_id"), str):
            secret_by_task[entry["task_id"]] = entry
    for task_id, group in by_task.items():
        entry = secret_by_task.get(task_id)
        if entry is None:
            stats["missing"] += 1
            continue
        if entry.get("shredded") is True:
            stats["shredded"] += 1
            continue
        stats["checked"] += 1
        failure = _check_task_secrets(group, entry)
        if failure:
            return {"failure": failure, "stats": stats}
    for receipt in receipts:
        body = receipt.get("body") if isinstance(receipt.get("body"), dict) else {}
        if body.get("kind") != "violation":
            continue
        entry = next(
            (
                item
                for item in secrets
                if isinstance(item, dict) and item.get("kind") == "violation" and item.get("receipt_id") == receipt.get("id")
            ),
            None,
        )
        if entry is None:
            stats["missing"] += 1
            continue
        stats["checked"] += 1
        salt = entry.get("salt")
        description = entry.get("description")
        if not isinstance(salt, str) or not isinstance(description, str):
            return {"failure": _fail(receipt, "secrets", "violation description does not match the secret"), "stats": stats}
        mac = text_commit(b64url_decode_lenient(salt), description)
        if mac != body.get("description_commit"):
            return {"failure": _fail(receipt, "secrets", "violation description does not match the secret"), "stats": stats}
    return {"failure": None, "stats": stats}


def _js_string(value: object, *, missing: bool = False) -> str:
    if missing:
        return "undefined"
    if value is None:
        return "null"
    return str(value)


def verify_receipt_chain(receipts: list, keys: dict, *, secrets: list | None = None) -> VerifyReport:
    ordered = _sort_by_seq(list(receipts))
    stats = _collect_stats(ordered)
    warnings = _collect_warnings(ordered)
    if len(ordered) == 0:
        return VerifyReport(True, warnings, stats)
    for index, receipt in enumerate(ordered):
        if not isinstance(receipt, dict):
            return VerifyReport(False, warnings, stats, _fail(None, "structure", "unsupported receipt version"))
        structure = _check_structure(receipt)
        if structure:
            return VerifyReport(False, warnings, stats, _fail(receipt, "structure", structure))
        if receipt_hash(unsigned_receipt(receipt)) != receipt.get("hash"):
            return VerifyReport(False, warnings, stats, _fail(receipt, "hash", "hash does not match the canonical receipt"))
        signature = _key_valid(keys, receipt)
        if signature:
            return VerifyReport(False, warnings, stats, _fail(receipt, "signature", signature))
        if index == 0:
            if receipt.get("seq") != 1:
                return VerifyReport(False, warnings, stats, _fail(receipt, "chain", "export must start at seq 1"))
            if receipt.get("prev_hash") != GENESIS_HASH:
                return VerifyReport(False, warnings, stats, _fail(receipt, "chain", "genesis prev_hash mismatch"))
        else:
            prev = ordered[index - 1]
            if not isinstance(prev, dict) or receipt.get("seq") != prev.get("seq") + 1:
                prev_seq = prev.get("seq") if isinstance(prev, dict) else None
                return VerifyReport(False, warnings, stats, _fail(receipt, "chain", f"seq gap after {prev_seq}"))
            if receipt.get("prev_hash") != prev.get("hash"):
                return VerifyReport(False, warnings, stats, _fail(receipt, "chain", "prev_hash does not match the previous receipt"))
    versions = _check_versions(ordered)
    if versions:
        return VerifyReport(False, warnings, stats, versions)
    for receipt in ordered:
        if not isinstance(receipt, dict):
            continue
        plaintext = _check_plaintext(receipt)
        if plaintext:
            return VerifyReport(False, warnings, stats, _fail(receipt, "plaintext", plaintext))
    commitments = _check_commitments(ordered)
    if commitments:
        return VerifyReport(False, warnings, stats, commitments)
    machine = _check_state_machines(ordered)
    if machine:
        return VerifyReport(False, warnings, stats, machine)
    semantic = _check_semantics(ordered)
    if semantic:
        return VerifyReport(False, warnings, stats, semantic)
    if secrets is not None:
        checked = _check_secrets(ordered, secrets)
        stats["secrets"] = checked["stats"]
        if checked["failure"]:
            return VerifyReport(False, warnings, stats, checked["failure"])
    return VerifyReport(True, warnings, stats)


def parse_receipt_jsonl(text: str) -> list:
    receipts: list = []
    for line in text.split("\n"):
        trimmed = line.strip()
        if not trimmed:
            continue
        receipts.append(loads_strict(trimmed))
    return receipts


def verify_jsonl(text: str, keys: dict, *, secrets: list | None = None) -> VerifyReport:
    return verify_receipt_chain(parse_receipt_jsonl(text), keys, secrets=secrets)


def check_receipt(receipt: dict, keys: dict) -> tuple[bool, str | None]:
    structure = _check_structure(receipt)
    if structure:
        return False, structure
    if receipt_hash(unsigned_receipt(receipt)) != receipt.get("hash"):
        return False, "hash mismatch"
    signature = _key_valid(keys, receipt)
    if signature:
        return False, signature
    return True, None
