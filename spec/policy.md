[English](policy.md) | [简体中文](zh-CN/policy.md)

# Policy

## Source of truth

- `packages/core/src/policy/schema.ts` (`policyDocumentSchema` is the only normative definition today; there is no `policy.schema.json` yet)
- `packages/core/src/policy/load.ts`
- `packages/core/src/policy/evaluate.ts`
- `packages/core/src/policy/match.ts`
- `packages/core/src/default-policy.ts`

If this document disagrees with the code, the code wins.

## 1. Document shape

A policy is YAML. The top level is parsed by `policyDocumentSchema`.

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | MUST be the integer `1` |
| `defaults` | no | When omitted, use the defaults in section 2 |
| `coverage` | no | Array of coverage declarations |
| `actions` | no | Action catalog. Keys are action types |
| `rules` | no | Ordered rules |

A zod object strips unknown keys by default and does not error for that. A known key with the wrong type, a YAML parse failure, or an illegal duration or time zone throws `422 policy_invalid`.

## 2. defaults

| Field | Values | Default |
| --- | --- | --- |
| `unknown_action` | `allow`, `require_approval`, `deny`, `draft_only` | `require_approval` |
| `timezone` | An IANA time zone name that `hourInTimeZone` accepts | `UTC` |
| `content_mode` | `strict` or `warn` | `strict` |
| `approval` | See section 4 | Each child uses the section 4 default |
| `claim_deadline` | duration | `24h` |
| `execution_timeout` | duration | `15m` |

A duration MUST match `^(\d+)(ms|s|m|h|d)$`.

## 3. actions and the ladder

`level` MUST be one of `ACTION_LEVELS`: `read`, `draft`, `write`, `send`, `spend`, `delete`.

High-risk levels are `HIGH_RISK_LEVELS`: `send`, `spend`, `delete`.

Optional fields:

- `blast_radius`: `self`, `others`, `public`. At evaluation time the request's own value wins, otherwise the catalog, otherwise `self`.
- `reversible`: a boolean. Same precedence: request, then catalog, then `true`.

If a high-risk action is not hit by any `coverage` entry's `action` glob, loading emits the warning `uncovered_high_risk`. Loading is not rejected.

## 4. The approval object

`defaults.approval` and `approval` on a `require_approval` rule share one shape.

| Field | Default | Inheritance |
| --- | --- | --- |
| `channels` | `[]` | If the key appears on the rule object, it replaces the default, including an empty array |
| `timeout` | `15m` | Same. MUST be a legal duration |
| `allow_edit` | `true` | Same |
| `min_assurance` | `app_asserted` | Same. MUST be `app_asserted`, `channel_verified`, or `user_signed` |
| `step_up` | `null` (when the field is omitted) | Replaced only when the rule writes it, including `null` |

`step_up` is one of:

- A non-empty string, the method name, for example `webauthn`.
- `{ when, method }`. `when` uses the match object from section 6. When it matches, the method name applies. Otherwise this decision has no step-up.
- `null`, meaning no step-up.

`defaults.approval.step_up` is a legal default. A `require_approval` rule that has no `step_up` of its own inherits it. Evaluation places the merged result on the decision only when `effect` is `require_approval`. The step-up of an `allow` decision is `null`.

Writing `approval` on an `allow`, `deny`, or `draft_only` rule, including a rule that only sets `step_up`, throws `422 policy_invalid` at load time because `rules.<id>.approval is only allowed on require_approval rules`. A `step_up` written on `defaults.approval` is not rejected.

## 5. rules

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Non-empty. MUST be unique in the document |
| `match` | yes | Match object. Multiple keys are AND |
| `effect` | yes | `EFFECTS`: `allow`, `require_approval`, `deny`, `draft_only` |
| `approval` | no | Allowed only on `require_approval` |
| `execution_timeout` | no | Overrides the default execution timeout |
| `ladder.promote_hint` | no | Copied onto the decision. This round does not auto-promote |
| `ladder.demote_on` | no | Array of strings. Evaluation does not read it this round |

Rules are tried in array order. The first matching rule wins.

## 6. match syntax

`match.ts` is the source of truth. Paths that can be resolved:

| Path | Value |
| --- | --- |
| `action` | Action type string |
| `level` | Level from the catalog. The path does not exist when the action was not declared |
| `attrs.<key>` | Request attributes |
| `amount.value`, `amount.currency` | Amount. The amount must be a safe integer. The currency is 3 uppercase letters |
| `time.hour` | Hour in the policy time zone, 0–23 |
| `grant.ladder_level` | Current ladder. Fixed at 0 this round |
| `principal.tags` | Principal tags. Defaults to an empty array this round |

An unknown path is treated as absent. It is not rejected at load time, but the clause fails at evaluation and the whole rule does not match.

An expected value has two forms:

- A scalar: the path exists and `===` is equal. `action: email.send` is an exact match. `*` is not expanded.
- An operator object. Keys MUST be among `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `between`, `not_between`, `glob`, `exists`. Operators inside one object are AND.

`glob` uses `globMatch`: with no `*` it is exact equality; `*` becomes `.*`, other regex characters are escaped, and the pattern matches the whole string. `email.*` matches `email.send`.

`between` and `not_between` on `time.hour` are the closed interval `[low, high]`. Both ends are numbers. `not_between: [9, 20]` matches when the hour is less than 9 or greater than 20.

Keys are AND with each other. An empty `match: {}` matches everything. Load time checks operator shape and integer ranges. An unknown operator throws `422 policy_invalid`.

## 7. Evaluation

1. Compute `time.hour` with `defaults.timezone`.
2. Find the first matching rule, in order.
3. When no rule matches, both declared and undeclared actions use `defaults.unknown_action`. The catalog difference is that a declared action has a `level`, so the high-risk `min_assurance` floor and `level` matches still apply. The rule id is recorded as `default:<effect>`.
4. `effect` chooses the next state: `allow` → `approved`, `require_approval` → `pending_approval`, `deny` → `rejected`, `draft_only` → `drafted`.
5. `step_up` applies only to `require_approval`. The algorithm is in section 4. `defaults.approval.step_up` is the default for that effect, not a load error.
6. `min_assurance` has a value only for `require_approval`. Other effects use `null`. If the rule wrote `min_assurance`, use it. Otherwise, if the level is high-risk and the default assurance is below `channel_verified`, raise it to `channel_verified`. If the default is already at least that high, keep the default. Otherwise use the default.
7. Comparison uses `assuranceRank`: `policy` 0, `app_asserted` 1, `channel_verified` 2, `user_signed` 3. The level obtained at approval MUST be greater than or equal to the required level.
8. `time.hour` uses `defaults.timezone`. An illegal time zone throws `422 policy_invalid` at load time.

## 8. Assurance levels

`app_asserted` is below `channel_verified`, which is below `user_signed`. Policy auto-approval uses `policy`, which is below those three.

When the local CLI uses an assurance above `app_asserted`, or `--step-up`, it marks the receipt `simulated: true`. The CLI does not perform a real channel identity check, and it does not collect a WebAuthn assertion. The verifier requires a non-empty step-up to carry `simulated: true`.

## 9. Coverage declarations

Each entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `action` | yes | A glob, same rules as `globMatch` |
| `mode` | yes | `recorded` or `enforced` |
| `via` | no | How it is integrated |

The first matching glob wins. When nothing matches, the mode is `recorded` and `coverage` is recorded as `none`.

At runtime the MCP proxy overlays each exposed tool's action as `mode: enforced`, `via: mcp-proxy`, inserted in front of the `coverage` list from the policy file. It does not rewrite `policy.yaml`.

## 10. Load warnings

`PolicyWarning.code` has two values:

| code | Emitted today |
| --- | --- |
| `uncovered_high_risk` | Yes. A high-risk action is not covered by any coverage glob |
| `high_risk_low_assurance` | The code exists on the type. `validatePolicy` does not emit it today |

Warnings do not block loading.

## 11. Example

The full `DEFAULT_POLICY`:

```yaml
version: 1
defaults:
  unknown_action: require_approval
  timezone: UTC
  content_mode: strict
  approval:
    channels: [cli]
    timeout: 15m
    allow_edit: true
    min_assurance: app_asserted
  claim_deadline: 24h
  execution_timeout: 15m

coverage:
  - action: email.*
    mode: recorded
    via: cli-demo
  - action: db.*
    mode: recorded
    via: credential-gate

actions:
  email.read:
    level: read
  email.send:
    level: send
    blast_radius: others
    reversible: false
  calendar.create:
    level: write
    blast_radius: self
    reversible: true
  db.delete:
    level: delete
    reversible: false

rules:
  - id: deny-prod-delete-at-night
    match:
      action: db.delete
      attrs.env: prod
      time.hour:
        not_between: [9, 20]
    effect: deny

  - id: prod-delete-step-up
    match:
      action: db.delete
      attrs.env: prod
    effect: require_approval
    approval:
      step_up: webauthn
      min_assurance: user_signed
      timeout: 10m
      allow_edit: false
    execution_timeout: 5m

  - id: read-allow
    match:
      level: read
    effect: allow

  - id: email-external-approve
    match:
      action: email.send
    effect: require_approval
    approval:
      min_assurance: channel_verified
      allow_edit: true

  - id: calendar-allow
    match:
      action: calendar.create
    effect: allow
```

## Consistency

Behavior is covered by `packages/core/test/policy.test.ts`. `policy.schema.json` will be added later. Until then, the zod schema is the only machine-readable definition.
