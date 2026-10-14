[English](receipt.md) | [简体中文](zh-CN/receipt.md)

# Receipts

## Source of truth

- `spec/receipt.schema.json` (`$defs/v01`, `$defs/v02`, `actor`, `sig`, `transition`)
- `packages/core/src/receipts.ts` (`buildReceipt`, `unsignedReceipt`, `receiptHash`)
- `packages/core/src/canonical.ts` (`jcs`, `sha256Prefixed`, `commit`, `GENESIS_HASH`)
- `packages/core/src/crypto.ts` (Ed25519, `KeySet`, `PublicKeyRecord`)
- `packages/core/src/secrets.ts` (constants, `REASONS`, `payloadCommit`, `textCommit`, secrets entries)
- `packages/core/src/time.ts` (`formatTimestamp`)
- `packages/core/src/ids.ts`
- `keyValid` in `packages/core/src/verify.ts`

If this document disagrees with the code, the code wins.

## 1. Overview

A receipt records one state transition, or a ledger event that does not enter the task state machine (policy publication, coverage declaration, violation). Receipts are append-only and form a hash chain ordered by `seq`. `buildReceipt` currently writes `actledger.receipt/0.2`. Version 0.1 MUST still verify.

## 2. Data conventions

- Timestamps: producers MUST use `formatTimestamp`, which is `Date.toISOString()`. The form is ISO 8601 UTC with milliseconds, ending in `Z`, for example `2026-10-13T08:00:00.000Z`. The verifier only requires `issued_at` to be a string. Key retirement compares strings, so producers MUST keep this one format.
- IDs: `newId(prefix)` is `prefix` + `_` + a 26-character Crockford base32 ULID. Prefixes used by this implementation are `app`, `tsk`, `rcp`, `sec`, `apr`, `vio`. The verifier only requires `id` to be a string.
- Hashes: `sha256:` + 64 lowercase hex digits (`SHA_RE`). For 0.2, `hash` and `prev_hash` MUST match. The 0.1 schema only requires a string.
- Commitments: `hmac-sha256:` + 64 lowercase hex digits (`COMMIT_RE`).
- Error codes: `^[a-z0-9_.]{1,64}$` (`ERROR_CODE_RE`).
- Public keys and signatures: base64url, no padding. The public key is the 32-byte raw Ed25519 key.

## 3. Top-level fields

0.1 and 0.2 have the same `required` list. `additionalProperties` is `false`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `v` | string | yes | `actledger.receipt/0.1` or `actledger.receipt/0.2` |
| `id` | string | yes | Receipt id |
| `app_id` | string | yes | Ledger app |
| `seq` | integer ≥ 1 | yes | Chain sequence, contiguous from 1 |
| `prev_hash` | string | yes | Previous receipt's `hash`. For 0.2 this MUST be a `sha256:` hash. The first receipt uses the genesis hash |
| `task_id` | string or null | yes | Task id. `null` for non-task events |
| `transition` | object or null | yes | `{ from, to }`. `from` is a string or `null`. `null` for non-task events |
| `actor` | object | yes | Who wrote this receipt |
| `body` | object | yes | Transition contents. 0.2 adds further limits |
| `evidence` | array | yes | `EvidenceRef` array, may be empty |
| `issued_at` | string | yes | Issue time |
| `hash` | string | yes | Hash of the receipt with `hash` and `sig` removed. For 0.2 this MUST be a `sha256:` hash |
| `sig` | object | yes | Ed25519 signature |

`actor` has `additionalProperties: false` and requires `type` and `id`. `type` is `agent`, `user`, `policy`, or `system`.

`sig` has `additionalProperties: false` and requires `alg`, `kid`, and `value`. `alg` MUST be `Ed25519`.

When `transition` is an object it requires `from` and `to`, and `additionalProperties` is `false`.

## 4. Body fields in 0.2

The schema lists these fields and forbids `note`, `description`, and `result` at the top of `body`. `body` itself does not set `additionalProperties: false`, so an implementation may also write keys that are not in the table below. The verifier forbids plaintext, not unknown keys.

| Field | Meaning |
| --- | --- |
| `initiator.principal_id` | Principal |
| `initiator.agent_id` | Agent. May be `null` and then omitted |
| `initiator.intent_commit` | `textCommit` of the intent. 0.2 MUST NOT contain `initiator.intent` |
| `error.code` | Error code matching `ERROR_CODE_RE` |
| `error.message_commit` | `textCommit` of the error message. MUST NOT contain `error.message` |
| `error.retryable` | Optional boolean |
| `payload_hash` | Commitment of the request payload. See [payload.md](payload.md) |
| `approved_payload_hash` | Commitment of the approved payload |
| `executed_hash` | Commitment of the executed payload |
| `note_commit` | `textCommit` of a reject, revoke, or reconcile note |
| `description_commit` | `textCommit` of a violation description |
| `reason` | See the table below |
| `approval.presented_hash` | The `payload_hash` the approver saw |
| `approval.edited_payload_hash` | If the payload was edited at approval, the new approval commitment |

`reason` is grouped by the target state and matches `REASONS`:

| Target state | Allowed `reason` |
| --- | --- |
| `rejected` | `rejected_by_user`, `denied_by_policy` |
| `drafted` | `draft_only` |
| `expired` | `approval_timeout`, `claim_deadline` |
| `unknown` | `execution_timeout` |
| `revoked` | `revoked` |
| `failed` | `reconciled_not_executed` |

A 0.2 body MUST NOT contain plaintext intent, error text, or notes. Specifically, it MUST NOT contain `initiator.intent`, `note`, `description`, `result`, `approval.note`, or `error.message`. If `reason` is present, it MUST be an enum value from the table above, not free text.

The current engine also writes `kind` (`task.transition`), `action`, `policy`, `integration`, `drift_applied`, `content_match`, `mismatch`, `external_proofs`, and `evidence_assurance` on task receipts. Those fields are covered by the hash. The verifier checks the relationships that involve commitments and whether content matches. See [verify.md](verify.md).

## 5. Actor and evidence

In the schema, `actor.type` is `agent`, `user`, `policy`, or `system`. The verifier's `structure` step only checks that `type` and `id` are strings.

`EvidenceRef`:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | For example `payload` |
| `sha256` | yes | The field name is kept from the older name. For 0.2 payload evidence this holds an `hmac-sha256:` commitment. The prefix distinguishes the algorithm |
| `uri` | no | Where the evidence lives |
| `size` | no | For payload evidence, the UTF-8 byte length of the canonical JSON |
| `mime` | no | For payload evidence, `application/json` |
| `captured_at` | no | Capture time |

`assurance` has three levels, low to high: `app_asserted`, `channel_verified`, `user_signed`. Policy auto-approval uses `policy`, which is below those three.

`simulated`: when a local CLI approval is above `app_asserted`, or a step-up was declared, `approval.auth.simulated` is `true`. It means this approval had no real channel identity check.

`approval.channel` is `cli`, `web`, or `webhook_link`. `web` and `webhook_link` are always `app_asserted` and `simulated: false`.

## 6. Canonicalization (JCS)

Receipt hashes and commitments both start with `jcs`. The implementation covers a subset of RFC 8785 and rejects values outside that subset.

1. Object keys are sorted by UTF-16 code unit order, which is JavaScript string less-than.
2. Objects and arrays have no whitespace.
3. Numbers must be safe integers and are serialized with `String(value)`, without an exponent. Floats, numbers outside the safe-integer range, and bigint throw `non_canonical_number`.
4. Strings and key names use the escaping of `JSON.stringify`.
5. `null` and booleans use JSON literals.
6. `undefined`, `Date`, `Map`, `Set`, and class instances throw `invalid_request`. Ordinary objects whose prototype is `null` are allowed.

`spec/test-vectors/jcs.json` has 7 cases. Among them: an empty object becomes `{}`, an empty array becomes `[]`, `null` becomes `null`, `{"b":1,"a":2}` becomes `{"a":2,"b":1}`, and an object containing `é` sorts `a` first by code unit. The quoted-string case is the last entry in that file. Do not hand-write the escapes.

## 7. Commitment algorithm

```text
commit(salt, value) = "hmac-sha256:" + HMAC-SHA256(salt, utf8(jcs(value)))
```

`salt` is that task's 32 bytes. The salt does not enter the receipt.

- `textCommit(salt, text)` is `commit(salt, text)`. The message is a JSON string, including quotes. Intent and notes are intentionally not domain-separated: the same text in the same task produces the same commitment.
- `payloadCommit(salt, payload)` is `commit(salt, normalizePayload(payload))`.

`spec/test-vectors/commitments.json` fixes the salt hex and four cases: `string`, `object`, `zh`, and `payload`. Recomputing MUST equal the `commit` in the file.

## 8. Payload hashes

0.2 payload hashes are salted per task. The algorithm, and which payload each of the three fields covers, is in [payload.md](payload.md).

## 9. Receipt hash

`unsignedReceipt` keeps only `v`, `id`, `app_id`, `seq`, `prev_hash`, `task_id`, `transition`, `actor`, `body`, `evidence`, and `issued_at`. It MUST NOT include `hash` or `sig`.

```text
hash = "sha256:" + SHA-256(utf8(jcs(unsignedReceipt)))
```

JCS reorders keys, so the insertion order of the unsigned object does not affect the hash.

## 10. Signature

The algorithm is Ed25519. The value `buildReceipt` passes to `Signer.sign` is the `hash` string above, not the raw JCS text. Node's `sign(null, utf8(hash), privateKey)` signs those UTF-8 bytes. `sig.value` is the signature in base64url, no padding.

`kid` has the form `<app_id>#<key name>`. Local `init` uses `<app_id>#k<UTC year>a`, for example `app_...#k2026a`.

`keys.json`:

```json
{
  "keys": [
    {
      "kid": "app_...#k2026a",
      "alg": "Ed25519",
      "public_key": "<base64url of the 32-byte raw public key>",
      "created_at": "2026-10-13T08:00:00.000Z",
      "retired_at": null
    }
  ]
}
```

Validity rules in `keyValid`:

- `kid` MUST exist in `keys`.
- When `retired_at` is `null`, the key is not rejected because of time.
- When `retired_at` is a string, `issued_at > retired_at` rejects the receipt. The comparison is a string comparison.
- `created_at` is stored in the KeySet. `keyValid` does not require `issued_at` to be later than `created_at`.

Then verify Ed25519.

## 11. Hash chain

`seq` starts at 1 and is contiguous. Gaps are not allowed. The first receipt's `prev_hash` MUST equal `GENESIS_HASH`, which is `sha256:` followed by 64 `0` digits. Every later receipt's `prev_hash` MUST equal the previous receipt's `hash`.

## 12. Secrets file (`actledger.secrets/0.1`)

JSONL, one entry per line. Empty lines are skipped. The secrets file contains plaintext and MUST NOT be distributed with receipts.

`TaskSecretsEntry`:

| Field | Meaning |
| --- | --- |
| `v` | `actledger.secrets/0.1` |
| `kind` | `task` |
| `task_id` | Task |
| `principal_id` | Principal |
| `shredded` | Optional. `true` after crypto-shred, and the entry no longer carries salt or plaintext |
| `payload_salt` | base64url of the 32-byte task salt. Older unsalted entries use `null` |
| `intent` | Intent plaintext, may be `null` |
| `payload` | Request payload |
| `approved_payload` | Approved payload. May equal the request, or be an edited object |
| `executed_payload` | Executed payload |
| `result` | Execution result |
| `error` | `{ code, message }` |
| `notes` | `{ reject, revoke, reconcile }`. Values are strings or `null` |
| `proofs` | `{ index, type?, salt, value }`. `type` may be absent on schema-1 proofs |

`ViolationSecretsEntry`:

| Field | Meaning |
| --- | --- |
| `v` | `actledger.secrets/0.1` |
| `kind` | `violation` |
| `receipt_id` | Violation receipt |
| `salt` | That description's own salt, base64url |
| `description` | Plaintext description |

Crypto-shred deletes that principal's data key. The exported task entry then contains only `v`, `kind`, `task_id`, `principal_id`, and `shredded: true`. The verifier counts it as `shredded` and does not treat it as a failure.

## 13. 0.1, 0.2, and compatibility

0.1 may carry plaintext `initiator.intent` and a plaintext error message. Payload hashes in the 0.1 vectors are unsalted `sha256:`. 0.2 MUST NOT carry that plaintext. Payload hashes are salted `hmac-sha256:`.

When `verify` sees 0.1 plaintext it only emits the warning `v01_plaintext`. `ok` stays `true`. The same task MUST NOT mix the two versions. Mixing fails at the `version` step.

## 14. Example

This `executed` receipt is copied from seq 5 of `spec/test-vectors/receipts-chain-0.2.jsonl`:

```json
{"v":"actledger.receipt/0.2","id":"rcp_V02_0007","app_id":"app_01M4TZP16QSTEENC5EYCNF3AH9","seq":5,"prev_hash":"sha256:20f542cc31f73274d7730e016c89f7ea388aaf9a986797b2752ece8aa9fecd67","task_id":"tsk_V02_0001","transition":{"from":"executing","to":"executed"},"actor":{"type":"agent","id":"mail-agent"},"body":{"kind":"task.transition","initiator":{"principal_id":"u_1","agent_id":"mail-agent","intent_commit":"hmac-sha256:4e7301345b6e03743cf1ae62532e7d3a9161924e239e8832b22cbbc05a9576ec"},"action":{"type":"calendar.create","level":"write","blast_radius":"self","reversible":true},"policy":{"rule_id":"calendar-allow","policy_version":1,"ladder_level":0},"integration":{"mode":"recorded","coverage":"none","coverage_version":1},"payload_hash":"hmac-sha256:13d712a693131ebaad412aac2666c4fd914a1c3e3a8ae59fdd2f75b72841d4f8","approved_payload_hash":"hmac-sha256:13d712a693131ebaad412aac2666c4fd914a1c3e3a8ae59fdd2f75b72841d4f8","executed_hash":"hmac-sha256:13d712a693131ebaad412aac2666c4fd914a1c3e3a8ae59fdd2f75b72841d4f8","drift_applied":[],"content_match":true,"mismatch":false,"evidence_assurance":"E1","external_proofs":[]},"evidence":[],"issued_at":"2026-10-13T08:00:00.000Z","hash":"sha256:899f160f88f91ad1264d3b217de1f081675e578af3cb1173c23864b3f9a2933b","sig":{"alg":"Ed25519","kid":"app_01M4TZP16QSTEENC5EYCNF3AH9#k2026a","value":"Pm09DXxXTeloTVe6nmGJUhxCY8_OVXJbNTX-FjJOhlfC2WOl9YdKTrnOKJYibSJdIy4J_KwDmmimdSQxc4jwCg"}}
```

## Consistency

- `jcs.json`, `commitments.json`, and `keys.json` are as described above.
- `receipts-chain-0.1.jsonl`: 5 receipts, `ok`, warning `v01_plaintext`.
- `receipts-chain-0.2.jsonl`: `ok`. With `secrets-0.2.jsonl` it is also `ok`, and at least one task secrets entry is shredded.
