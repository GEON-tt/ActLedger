[English](verify.md) | [简体中文](zh-CN/verify.md)

# Verification

## Source of truth

- `packages/core/src/verify.ts` (`verifyReceiptChain`, `verifyJsonl`, `VerifyReport`)
- `verifyCommand` in `packages/cli/src/commands/export.ts`
- The command line in `packages/cli/src/main.ts`

If this document disagrees with the code, the code wins.

## 1. Inputs

- Receipt JSONL. One JSON value per line. Empty lines are skipped. The verifier processes receipts in ascending `seq`, so the file order need not be sequence order, but the sequence itself MUST be contiguous from 1.
- A KeySet, `keys.json`: `{ "keys": [ { kid, alg, public_key, created_at, retired_at } ] }`.
- An optional secrets JSONL. The format is in [receipt.md](receipt.md). Without it, the `secrets` step is not run.

## 2. Output

`VerifyReport`:

| Field | Meaning |
| --- | --- |
| `ok` | `true` when no step failed. Warnings do not change `ok` |
| `failure` | Present only on failure. `step`, `reason`, and that receipt's `id` and `seq` |
| `warnings[]` | Each item has `code`, `message`, and `count` |
| `stats.count` | Number of receipts |
| `stats.byVersion` | Counts by `v` |
| `stats.byMode` | Counts by `body.integration.mode` |
| `stats.byAssurance` | Counts by `body.approval.assurance` |
| `stats.unknown` | Count of receipts with `transition.to === "unknown"` |
| `stats.violations` | Count of receipts with `body.kind === "violation"` |
| `stats.secrets` | Present only when secrets were provided: `checked`, `shredded`, `missing` |

An empty chain has `ok` `true`.

## 3. Algorithm steps

`verifyReceiptChain` sorts by `seq`, collects statistics and warnings, then checks in the order below. It stops at the first failure. `step` is that step's name.

### 3.1 `structure`

`checkStructure` on each receipt:

- `v` MUST be `actledger.receipt/0.1` or `actledger.receipt/0.2`.
- `id` and `app_id` MUST be strings. `seq` MUST be a safe integer greater than or equal to 1.
- `prev_hash` and `hash` MUST be strings. For 0.2 they also MUST match `sha256:` plus 64 lowercase hex digits.
- `task_id` MUST be a string or `null`.
- `transition` is `null`, or `from` is a string or `null` and `to` is a string.
- `actor.type` and `actor.id` MUST be strings.
- `body` MUST be an object, `evidence` MUST be an array, and `issued_at` MUST be a string.
- `sig.alg` MUST be `Ed25519`. `kid` and `value` MUST be strings.

### 3.2 `hash`

`receiptHash(unsignedReceipt(receipt))` MUST equal `hash`. On mismatch the reason is `hash does not match the canonical receipt`.

### 3.3 `signature`

`keyValid`:

1. Look up the key by `sig.kid`. Missing key fails.
2. If `retired_at` is non-null and `issued_at > retired_at` (string comparison), fail. `created_at` is stored on the KeySet and is not checked in this step.
3. Verify Ed25519 over the `hash` string with that public key. On failure the reason is `signature mismatch`.

### 3.4 `chain`

After sorting, the first `seq` MUST be 1, and `prev_hash` MUST equal `GENESIS_HASH` (`sha256:` plus 64 `0` digits). Every later receipt's `seq` MUST equal the previous `seq` plus 1, and `prev_hash` MUST equal the previous `hash`. A partial export MUST therefore start at seq 1, or this step fails.

### 3.5 `version`

The same `task_id` MUST NOT mix `0.1` and `0.2`.

### 3.6 `plaintext`

Checked only for 0.2. Forbidden: `initiator.intent`, top-level `note`, `description`, `result`, `approval.note`, and `error.message`. If `reason` is present, it MUST be an enum allowed for that target state. `error` may contain only `code`, `message_commit`, and `retryable`. `code` matches `^[a-z0-9_.]{1,64}$`, and `message_commit` MUST be present.

### 3.7 `commitments`

`checkCommitments`. Commitment fields MUST match `hmac-sha256:` plus 64 hex digits. Within one task, `payload_hash` and `intent_commit` MUST stay unchanged. The `sha256` of `payload` evidence MUST equal `payload_hash`. `presented_hash` MUST equal `payload_hash`. `approved_payload_hash` MUST equal `edited_payload_hash` when that field is present, otherwise `payload_hash`. `approved_payload_hash` on `executing`, `executed`, and `failed` MUST equal the approval receipt. The equality of `executed_hash` and `approved_payload_hash` must agree with `content_match` and `drift_applied`. See [state-machine.md](state-machine.md).

### 3.8 `state_machine`

Rebuild transitions per task, in `seq` order. The first transition MUST be from `null` to `prepared`. Every later step MUST be a legal transition, MUST NOT leave a terminal state, MUST NOT claim more than once, and MUST NOT have more than one terminal receipt.

### 3.9 `semantics`

`checkSemantics`: an executed receipt must state `content_match` or `mismatch`. Approval assurance, step-up, and `decided_at` are in [state-machine.md](state-machine.md).

### 3.10 `secrets`

Runs only when secrets were provided. Recompute commitments with the salt. A task with `shredded: true` counts toward `shredded`, skips recomputation, and is not a failure. A missing entry counts toward `missing` and is not a failure. A mismatch between plaintext and the commitment is a failure.

For a 0.2 task, the salt is the base64url `payload_salt`. An older entry without `payload_salt` uses the unsalted `payloadHash`. A violation receipt uses that entry's own salt, `textCommit` of `description`, compared with `description_commit`.

## 4. Warnings

`v01_plaintext`: a 0.1 receipt whose `initiator` contains `intent`, or whose `error` contains `message`, or whose body contains `note`, or whose `reason` is not an enum for that target state. The message is `0.1 receipts contain plaintext intent, error message, note or reason`. `count` is the number of such receipts.

A warning MUST NOT turn `ok` into `false`.

## 5. CLI behavior

```text
actledger verify <file> --keys <keys.json> [--secrets <file>] [--json]
```

- Exit 0 on success, exit 1 on failure.
- On success, stdout is one line: `OK <count> receipts  unknown=<n> violations=<n>`. When secrets were provided, append ` secrets=<checked>/<shredded>/<missing>`.
- On failure, stderr is: `FAIL seq=<seq> step=<step> <reason>`.
- Each warning is written to stderr: `WARN <code>: <message> (<count>)`. The 0.1 vector therefore prints a warning, and the exit code is still 0.
- `--json` prints the whole `VerifyReport` to stdout and does not print the human-readable OK line.

`node:sqlite` may write `ExperimentalWarning` to stderr. Callers MUST NOT treat non-empty stderr as failure.

## 6. What a verifier can and cannot prove

It can prove: submitted receipts were not tampered with, the signature was valid while the key was not retired, transitions of the same task are legal, 0.2 has no plaintext, and commitments match plaintext when secrets are provided.

It cannot prove: every action was recorded, or that the identity behind `assurance` is real. The local CLI can mark an approval above `app_asserted` as `simulated`.

## 7. Consistency

| Vector | Expectation |
| --- | --- |
| `jcs.json` | JCS of each `value` equals `jcs` |
| `commitments.json` | Recomputed with `salt_hex`, equals each `commit` |
| `keys.json` | Contains the public keys of both the 0.1 and 0.2 chains |
| `receipts-chain-0.1.jsonl` | `ok`, 5 receipts, warning `v01_plaintext` |
| `receipts-chain-0.2.jsonl` | `ok` |
| The same plus `secrets-0.2.jsonl` | `ok`, `checked > 0`, `shredded >= 1` |

### Tamper samples

Tamper samples are generated by tests at runtime. They are not committed as files. For example, change a body field of a signed receipt, or change one byte, and do not recompute `hash`: expect failure at the `hash` step. Delete a middle sequence number and the `chain` step fails. Change the executed payload or the intent plaintext in secrets and the `secrets` step fails.

The Python implementation is in `python/`. It uses the same vectors and is compared by `scripts/verify-parity.ts`.
