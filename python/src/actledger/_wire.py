from __future__ import annotations

from datetime import datetime, timezone


def _omit_none(params: dict) -> dict:
    return {key: value for key, value in params.items() if value is not None}


def request_params(
    *,
    principal_id: str,
    action: dict,
    payload: dict,
    intent: str | None = None,
    agent_id: str | None = None,
    expires_in: int | None = None,
    idempotency_key: str | None = None,
    metadata: dict | None = None,
) -> dict:
    return _omit_none(
        {
            "principalId": principal_id,
            "agentId": agent_id,
            "intent": intent,
            "action": action,
            "payload": payload,
            "expiresIn": expires_in,
            "idempotencyKey": idempotency_key,
            "metadata": metadata,
        }
    )


def claim_params(task_id: str, idempotency_key: str, agent_id: str | None = None) -> dict:
    return _omit_none({"id": task_id, "idempotencyKey": idempotency_key, "agentId": agent_id})


def complete_params(
    task_id: str,
    executed_payload: dict,
    *,
    external_proofs: list | None = None,
    result: dict | None = None,
    idempotency_key: str | None = None,
) -> dict:
    return _omit_none(
        {
            "id": task_id,
            "executedPayload": executed_payload,
            "externalProofs": external_proofs,
            "result": result,
            "idempotencyKey": idempotency_key,
        }
    )


def fail_params(task_id: str, error: dict, idempotency_key: str) -> dict:
    return {"id": task_id, "error": error, "idempotencyKey": idempotency_key}


def revoke_params(task_id: str, idempotency_key: str, reason: str | None = None) -> dict:
    return _omit_none({"id": task_id, "reason": reason, "idempotencyKey": idempotency_key})


def degraded_task_view(payload_hash: str = "sha256:degraded") -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return {
        "id": "tsk_degraded",
        "appId": "degraded",
        "principalId": "degraded",
        "agentId": None,
        "intentCommit": None,
        "action": {
            "type": "read",
            "level": "read",
            "resource": None,
            "blastRadius": "self",
            "reversible": True,
            "amount": None,
            "attrs": {},
        },
        "payloadHash": payload_hash,
        "approvedPayloadHash": payload_hash,
        "integrationMode": "recorded",
        "coverageVia": None,
        "coverageMatched": False,
        "state": "approved",
        "decision": {
            "result": "allow",
            "ruleId": "degraded",
            "policyVersion": 0,
            "ladderLevel": 0,
            "minAssurance": None,
            "integrationMode": "recorded",
            "coverageVia": None,
            "coverageMatched": False,
            "contentMode": "warn",
            "allowEdit": False,
            "stepUp": None,
            "channels": [],
            "executionTimeoutMs": 0,
            "claimDeadlineMs": 0,
            "approvalTimeoutMs": 0,
            "promotionHint": None,
            "level": "read",
            "blastRadius": "self",
            "reversible": True,
        },
        "approvalId": None,
        "claimedAt": None,
        "executionDeadline": None,
        "claimDeadline": None,
        "executedHash": None,
        "contentMatch": None,
        "mismatch": False,
        "error": None,
        "expiresAt": None,
        "idempotencyKey": None,
        "createdAt": now,
        "updatedAt": now,
    }
