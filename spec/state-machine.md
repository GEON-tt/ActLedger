[English](state-machine.md) | [简体中文](zh-CN/state-machine.md)

# State machine

## Source of truth

- `spec/transitions.json`
- `packages/core/src/states.ts` (`STATES`, `TERMINAL_STATES`, `TRANSITIONS`, `assertTransition`)
- `checkStateMachines` and `checkSemantics` in `packages/core/src/verify.ts`
- `packages/core/src/engine.ts` (`claim`, `sweep`, `unknown`)
- `REASONS` in `packages/core/src/secrets.ts`
- `parseDurationMs` in `packages/core/src/time.ts`

If this document disagrees with the code, the code wins.

## 1. States

A task has 11 states.

| State | Meaning | Terminal |
| --- | --- | --- |
| `prepared` | The request is recorded and policy has not moved it on yet. `transition.from` is `null` on entry | no |
| `pending_approval` | Waiting for a user approval | no |
| `approved` | Approved, not yet claimed | no |
| `executing` | Claimed and running | no |
| `executed` | Execution finished | yes |
| `failed` | Execution failed, or content mismatched in strict mode | yes |
| `unknown` | Timed out after claim. Must not be treated as not executed | no |
| `rejected` | Rejected by the user, or denied by policy | yes |
| `drafted` | Policy allows a draft only. Do not execute | yes |
| `expired` | Approval timed out, or the claim deadline passed | yes |
| `revoked` | Revoked before execution | yes |

The terminal states are `executed`, `failed`, `rejected`, `drafted`, `expired`, and `revoked`. A terminal state MUST NOT be left.

## 2. Legal transitions

These match `transitions.json` entry for entry. The key is the source state. The value is the allowed targets. An empty array means there is no outgoing edge.

- `prepared` → `approved`, `pending_approval`, `rejected`, `drafted`
- `pending_approval` → `approved`, `rejected`, `expired`, `revoked`
- `approved` → `executing`, `revoked`, `expired`
- `executing` → `executed`, `failed`, `unknown`
- `unknown` → `executed`, `failed`
- `executed`, `failed`, `rejected`, `drafted`, `expired`, and `revoked` have no outgoing edges

The first receipt of a task that carries `transition` MUST be `{ "from": null, "to": "prepared" }`. Every later receipt's `from` MUST equal the task's current state, and MUST appear in the outgoing edges above.

## 3. Who triggers each transition, and what the receipt requires

`reason` may appear only when the target state is in `REASONS`, and the value must belong to that group. If `reason` on a 0.2 receipt is not an enum value, the `plaintext` step fails.

| Transition | Trigger | Receipt |
| --- | --- | --- |
| `prepared` → `approved` | Policy, `effect: allow` | `approval.approver` is `policy:<rule id>`. `approval.assurance` is `policy`. There is no user `min_assurance`. `presented_hash` MUST equal `payload_hash` |
| `prepared` → `pending_approval` | Policy, `effect: require_approval` | No terminal `reason` |
| `prepared` → `rejected` | Policy, `effect: deny` | `reason` MUST be `denied_by_policy` |
| `prepared` → `drafted` | Policy, `effect: draft_only` | `reason` MUST be `draft_only` |
| `pending_approval` → `approved` | User approval | See the approval receipt below |
| `pending_approval` → `rejected` | User rejection | `reason` MUST be `rejected_by_user`. A note, if any, is only `note_commit` |
| `pending_approval` → `expired` | System, `approval.timeout` | `reason` MUST be `approval_timeout` |
| `pending_approval` → `revoked` | Revoke | `reason` MUST be `revoked` |
| `approved` → `executing` | Executor `claim` | Can succeed only once. `approved_payload_hash` MUST equal the value on the approval receipt |
| `approved` → `revoked` | Revoke | `reason` MUST be `revoked` |
| `approved` → `expired` | System, `claim_deadline` | `reason` MUST be `claim_deadline` |
| `executing` → `executed` | Executor completed, or reconciliation from `unknown` says it ran | See the execution receipt below |
| `executing` → `failed` | Executor `fail`, or content mismatch in strict mode | `error.code` and `error.message_commit`. On a content mismatch the code is `content_mismatch` |
| `executing` → `unknown` | System, `execution_timeout` | `reason` MUST be `execution_timeout` |
| `unknown` → `executed` | Reconciliation says it ran | Same as the execution receipt, plus `reconciled: true` |
| `unknown` → `failed` | Reconciliation says it did not run | `reason` MUST be `reconciled_not_executed` |

`rejected` allows `rejected_by_user` and `denied_by_policy`. `drafted` allows `draft_only`. `expired` allows `approval_timeout` and `claim_deadline`. `unknown` allows `execution_timeout`. `revoked` allows `revoked`. `failed` allows `reconciled_not_executed`. Other target states MUST NOT carry `reason`.

Approval receipt (`checkSemantics`):

- If `policy.min_assurance` is a string, `approval.assurance` MUST be `app_asserted`, `channel_verified`, or `user_signed`, and `assuranceRank` MUST be greater than or equal to the required level.
- If `policy.step_up` is a string, and the approver does not start with `policy:`, then `approval.auth.step_up` MUST equal that string, and `approval.auth.simulated` MUST be `true`.
- When `approval.auth.step_up` is not `null`, `simulated` MUST be `true`. There is no real channel authenticator yet. Step-up can only be marked simulated.
- When the approval is not a policy auto-approval, `assurance` and `decided_at` MUST be present. If an `executing` receipt follows, `decided_at` MUST be no later than that receipt's `issued_at`.

Execution receipt:

- When `to` is `executed`, either `content_match === true` or `mismatch === true` MUST hold.
- If `executed_hash` equals `approved_payload_hash`, then `content_match` MUST be `true` and `drift_applied` MUST be empty.
- If `content_match === true` and the two hashes differ, then `drift_applied` MUST be non-empty.

`policy.published`, `coverage.declared`, and `violation` are not task transitions. Their `transition` is `null`, and they do not enter this table.

## 4. Invariants

- A claim of `approved` → `executing` MUST succeed only once. A second claim gets `already_claimed`. If the verifier sees two claims of the same task, `state_machine` fails.
- If the process crashes after claim, or execution times out, the task enters `unknown`. It MUST NOT be treated as "not executed" and retried. When `request` is called again with the same idempotency key and the old task is still `unknown`, the engine rejects it with `unresolved_unknown`.
- The executed payload MUST match the approved payload, or the difference MUST be only on paths in the approved payload's `allowed_drift`. Comparison rules are in [payload.md](payload.md).
- Receipts are append-only. An implementation MUST NOT rewrite a receipt that has been written.
- A terminal state cannot be left. A task MUST NOT have two terminal receipts.

## 5. Timeouts

A duration is a string accepted by `parseDurationMs`: `^(\d+)(ms|s|m|h|d)$`. The units are milliseconds, seconds, minutes, hours, and days.

| Policy field | Default | Transition |
| --- | --- | --- |
| `defaults.approval.timeout`, overridable on a `require_approval` rule | `15m` | `pending_approval` → `expired`, `reason` `approval_timeout` |
| `defaults.claim_deadline` | `24h` | `approved` → `expired`, `reason` `claim_deadline`. The clock starts on entry to `approved` |
| `defaults.execution_timeout`, overridable by a rule's `execution_timeout` | `15m` | `executing` → `unknown`, `reason` `execution_timeout`. The clock starts at `claim` |

`sweep` scans these three deadlines. If approve or claim finds that a deadline has already passed, it writes the matching `expired` first, then rejects the operation.

`expiresIn` on a request (seconds, 1 to 7 days), when present, replaces the approval timeout for that request.

## 6. Enforced checkpoint

An external proxy or credential gate SHOULD let a task through only while it is `executing`. The current MCP proxy `claim`s before it forwards `tools/call` upstream, so the task enters `executing`.

## 7. `transitions.json` format

A JSON object. Keys are source states. Values are arrays of target states. Implementers SHOULD load this file and keep it aligned with `TRANSITIONS`.

## Consistency

The verifier's `state_machine` step rebuilds each task's transition sequence. `packages/core/test/states.test.ts` compares `TRANSITIONS` with `transitions.json` entry for entry.
