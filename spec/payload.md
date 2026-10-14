[English](payload.md) | [简体中文](zh-CN/payload.md)

# Payload

## Source of truth

- `spec/payload.schema.json`
- `packages/core/src/payload.ts` (`normalizePayload`, `payloadHash`, `compareWithDrift`, `assertDriftPath`)
- `payloadCommit` in `packages/core/src/secrets.ts`
- `finish` and `applyApproval` in `packages/core/src/engine.ts`
- `ContentMismatch` in `packages/sdk/src/ledger.ts`
- Informative reference: `packages/mcp-proxy/src/payload.ts`

If this document disagrees with the code, the code wins.

## 1. Structure

`$id` is `https://actledger.dev/schema/payload-0.1.json`. `additionalProperties` is `false`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | string | yes | Action type. MUST equal `action.type` on the request |
| `args` | object | yes | Arguments. MUST be an object. MUST NOT be an array |
| `content` | object | no | The schema only requires an object. Producers use `content_type`, plus optional `text`, `ref`, and `sha256` |
| `allowed_drift` | array of strings | no | Paths that may change at execution time |

## 2. Normalization

`normalizePayload`:

1. `action` MUST be a non-empty string, otherwise `400 invalid_request`.
2. `args` MUST be a non-array object.
3. The output object places `action`, then `args`. `content` is written only when the caller provided it. `allowed_drift` is written only when it was provided.
4. `allowed_drift` MUST be an array of strings, and each entry MUST pass `assertDriftPath`.
5. The result is passed to `jcs`. Floats, `undefined`, bigint, and other non-JSON values are rejected here.
6. Default fields are not filled in. Empty strings are not deleted. Array order is not changed. Key order is sorted only by JCS.

## 3. Hash and commitment

The 0.1 payload hash is the unsalted `payloadHash`:

```text
sha256: + SHA-256(jcs(normalizePayload(payload)))
```

The 0.2 payload hash is the salted `payloadCommit`:

```text
hmac-sha256: + HMAC-SHA256(taskSalt, jcs(normalizePayload(payload)))
```

The current `LedgerEngine` issues only 0.2, so these three fields on new receipts are `hmac-sha256:`. When a secrets entry has no `payload_salt`, the verifier recomputes the unsalted 0.1 `payloadHash`.

| Receipt field | Which payload |
| --- | --- |
| `payload_hash` | The payload submitted at request time. It MUST stay unchanged within one task |
| `approved_payload_hash` | The approved payload. Equals `payload_hash` when there was no edit. Equals the edited payload when there was an edit |
| `executed_hash` | The payload the executor actually ran |

## 4. `allowed_drift` path syntax

`assertDriftPath` throws `400 invalid_request` when it rejects a path. A path MUST:

- Be non-empty, not start or end with `.`, and contain no empty segment.
- Not use the segment names `__proto__`, `prototype`, or `constructor`.
- Have at least two segments. The first segment is `args` or `content`.

`args.signature` is legal. `action`, `args`, `body.x`, and `args.` are not. The separator is `.`.

## 5. Comparison

`compareWithDrift(approved, executed)`:

1. Paths come from `allowed_drift` on the approved payload. The default is an empty array. Each path passes `assertDriftPath` first.
2. `driftApplied` is the paths whose lookups differ on the two sides. A missing value and a found `undefined` are not the same. Values are compared with `jcs`.
3. Both sides are passed through `normalizePayload`, then `allowed_drift` itself is removed, then the allowed-drift leaves are removed, then the JCS texts are compared.
4. `match` is true if and only if the JCS texts are equal after that stripping. `allowed_drift` itself is not part of the comparison.

`defaults.content_mode` is `strict` or `warn`. The default is `strict`. It is a default for the whole policy, not a field on a single rule.

- `strict`: when `match` is false, the task enters `failed`, `error.code` is `content_mismatch`, and the engine throws `422 content_mismatch`. The SDK wraps that as `ContentMismatch`.
- `warn`: when `match` is false the task still enters `executed`. The receipt has `content_match` `false`, `mismatch` `true`, and `drift_applied` lists the paths that changed.

The SDK's `strictContent` defaults to `true`. It calls `compareWithDrift` again before completion. On a mismatch it `fail`s first, then throws `ContentMismatch`.

## 6. Editing at approval

`allow_edit` defaults to `true`. `approval.allow_edit` on a rule can override it.

When editing is open, the edited payload becomes the new approved payload: `approved_payload_hash` changes to the edited `payloadCommit`, and the receipt's `approval.edited_payload_hash` records the same value. The edited `action` MUST still equal the task's action type.

When editing is closed, submitting `editedPayload` MUST be rejected with `400 invalid_request`.

`approval.presented_hash` MUST equal the task's `payload_hash`, which is the version the approver saw.

## 7. MCP mapping (informative, not normative)

This section describes the current `@actledger/mcp-proxy`. It may change with the proxy version. A verifier MUST NOT depend on it.

- The arguments object of `tools/call` becomes `payload.args`.
- When `content.field` is configured and that field is a string, it moves from `args` to `payload.content`. `content_type` comes from the mapping.
- `allowedDrift` is copied into `payload.allowed_drift`.
- `attrs` contains at least `mcp_server` and `mcp_tool`. `attrsFrom` can copy scalar arguments into attributes. Those two reserved keys cannot be overwritten by the mapping.
- The fingerprint is `sha256` hex with no prefix. The input is `jcs({ server, tool, args })`. It is used to drop duplicate calls.

## 8. Example

The `email.send` payload in `scripts/gen-vectors.ts`. `allowed_drift` is `args.signature`:

```json
{
  "action": "email.send",
  "args": { "to": ["bob@clienta.com"], "subject": "Re: 报价" },
  "content": { "content_type": "text/plain", "text": "hello" },
  "allowed_drift": ["args.signature"]
}
```

## Consistency

With `receipts-chain-0.2.jsonl` and `secrets-0.2.jsonl`, `payload_hash`, `approved_payload_hash`, and `executed_hash` can be recomputed from the entry's `payload_salt` (base64url) and the plaintext payloads. The salt uses `payloadCommit`. The verifier does this in the `secrets` step. Shredded entries are not recomputed and are not failures.
