[English](../state-machine.md) | [简体中文](state-machine.md)

# 状态机

## 事实来源

- `spec/transitions.json`
- `packages/core/src/states.ts`（`STATES`、`TERMINAL_STATES`、`TRANSITIONS`、`assertTransition`）
- `packages/core/src/verify.ts` 的 `checkStateMachines`、`checkSemantics`
- `packages/core/src/engine.ts`（`claim`、`sweep`、`unknown`）
- `packages/core/src/secrets.ts` 的 `REASONS`
- `packages/core/src/time.ts` 的 `parseDurationMs`

和代码不一致时，以代码为准。

## 1. 状态

一次任务有 11 个状态。

| 状态 | 含义 | 终态 |
| --- | --- | --- |
| `prepared` | 请求已记下，策略尚未把它送走。进入时 `transition.from` 为 `null` | 否 |
| `pending_approval` | 等待用户批准 | 否 |
| `approved` | 已批准，还没有认领 | 否 |
| `executing` | 已认领，正在执行 | 否 |
| `executed` | 执行完成 | 是 |
| `failed` | 执行失败，或严格模式下内容不一致 | 是 |
| `unknown` | 认领后超时，不能当作没执行 | 否 |
| `rejected` | 用户拒绝，或策略直接拒绝 | 是 |
| `drafted` | 策略只允许起草，不执行 | 是 |
| `expired` | 批准超时，或认领期限已过 | 是 |
| `revoked` | 在执行前被撤销 | 是 |

终态是 `executed`、`failed`、`rejected`、`drafted`、`expired`、`revoked`。终态 MUST NOT 再离开。

## 2. 合法迁移

与 `transitions.json` 逐条相同。键是源状态，值是允许的目标。空数组表示没有出边。

- `prepared` → `approved`、`pending_approval`、`rejected`、`drafted`
- `pending_approval` → `approved`、`rejected`、`expired`、`revoked`
- `approved` → `executing`、`revoked`、`expired`
- `executing` → `executed`、`failed`、`unknown`
- `unknown` → `executed`、`failed`
- `executed`、`failed`、`rejected`、`drafted`、`expired`、`revoked` 没有出边

任务的第一条带 `transition` 的回执 MUST 是 `{ "from": null, "to": "prepared" }`。其后每条的 `from` MUST 等于该任务当前状态，并且 MUST 出现在上面的出边里。

## 3. 每条迁移的触发方和回执要求

`reason` 只有目标状态落在 `REASONS` 里时才允许出现，取值必须属于该组。0.2 回执里的 `reason` 如果不是枚举值，`plaintext` 步骤失败。

| 迁移 | 触发方 | 回执 |
| --- | --- | --- |
| `prepared` → `approved` | 策略，`effect: allow` | `approval.approver` 为 `policy:<rule id>`，`approval.assurance` 为 `policy`。没有用户 `min_assurance`。`presented_hash` MUST 等于 `payload_hash` |
| `prepared` → `pending_approval` | 策略，`effect: require_approval` | 不带终态 `reason` |
| `prepared` → `rejected` | 策略，`effect: deny` | `reason` MUST 是 `denied_by_policy` |
| `prepared` → `drafted` | 策略，`effect: draft_only` | `reason` MUST 是 `draft_only` |
| `pending_approval` → `approved` | 用户批准 | 见下方批准回执 |
| `pending_approval` → `rejected` | 用户拒绝 | `reason` MUST 是 `rejected_by_user`。备注若有，只记 `note_commit` |
| `pending_approval` → `expired` | 系统，`approval.timeout` | `reason` MUST 是 `approval_timeout` |
| `pending_approval` → `revoked` | 撤销 | `reason` MUST 是 `revoked` |
| `approved` → `executing` | 执行方 `claim` | 只能成功一次。`approved_payload_hash` MUST 等于批准回执上的值 |
| `approved` → `revoked` | 撤销 | `reason` MUST 是 `revoked` |
| `approved` → `expired` | 系统，`claim_deadline` | `reason` MUST 是 `claim_deadline` |
| `executing` → `executed` | 执行方完成，或从 `unknown` 对账为已执行 | 见下方执行回执 |
| `executing` → `failed` | 执行方 `fail`，或严格模式下内容不一致 | `error.code` 与 `error.message_commit`。内容不一致时 code 为 `content_mismatch` |
| `executing` → `unknown` | 系统，`execution_timeout` | `reason` MUST 是 `execution_timeout` |
| `unknown` → `executed` | 对账，结果是执行过 | 同执行回执，并带 `reconciled: true` |
| `unknown` → `failed` | 对账，结果是没执行 | `reason` MUST 是 `reconciled_not_executed` |

`rejected` 允许 `rejected_by_user`、`denied_by_policy`。`drafted` 允许 `draft_only`。`expired` 允许 `approval_timeout`、`claim_deadline`。`unknown` 允许 `execution_timeout`。`revoked` 允许 `revoked`。`failed` 允许 `reconciled_not_executed`。其他目标状态 MUST NOT 带 `reason`。

批准回执（`checkSemantics`）：

- 若 `policy.min_assurance` 是字符串，`approval.assurance` MUST 是 `app_asserted`、`channel_verified` 或 `user_signed`，且 `assuranceRank` MUST 大于等于所要求的等级。
- 若 `policy.step_up` 是字符串，并且批准人不是 `policy:` 开头，则 `approval.auth.step_up` MUST 等于该字符串，且 `approval.auth.simulated` MUST 是 `true`。
- `approval.auth.step_up` 不是 `null` 时，`simulated` MUST 是 `true`。当前没有真实的渠道认证器，step-up 只能标记为模拟。
- 不是策略自动批准时，MUST 有 `assurance` 和 `decided_at`。若之后有 `executing` 回执，`decided_at` MUST 不晚于该回执的 `issued_at`。

执行回执：

- `to` 为 `executed` 时，MUST 满足 `content_match === true` 或 `mismatch === true`。
- `executed_hash` 与 `approved_payload_hash` 相同，则 `content_match` MUST 为 `true`，并且 `drift_applied` MUST 为空。
- `content_match === true` 且两个哈希不同，则 `drift_applied` MUST 非空。

`policy.published`、`coverage.declared`、`violation` 不是任务迁移。它们的 `transition` 为 `null`，不进入这张表。

## 4. 不变量

- `approved` → `executing` 的 claim MUST 只能成功一次。再次 claim 得到 `already_claimed`。校验器若看到同一个任务两次 claim，在 `state_machine` 失败。
- 认领之后进程崩溃，或执行超时，任务进入 `unknown`。MUST NOT 把它当成「未执行」再试一次。同一幂等键再次 `request` 且旧任务仍是 `unknown` 时，引擎拒绝并返回 `unresolved_unknown`。
- 执行载荷 MUST 与批准载荷一致，或者差异只在批准载荷的 `allowed_drift` 里。比较规则见 [payload.md](payload.md)。
- 回执只追加。实现 MUST NOT 改写已写入的回执。
- 终态不可离开。一个任务 MUST NOT 有两个终态回执。

## 5. 超时

时长是 `parseDurationMs` 接受的字符串：`^(\d+)(ms|s|m|h|d)$`。单位分别是毫秒、秒、分、时、天。

| 策略字段 | 默认 | 迁移 |
| --- | --- | --- |
| `defaults.approval.timeout`，`require_approval` 规则可覆盖 | `15m` | `pending_approval` → `expired`，`reason` 为 `approval_timeout` |
| `defaults.claim_deadline` | `24h` | `approved` → `expired`，`reason` 为 `claim_deadline`。进入 `approved` 时开始计 |
| `defaults.execution_timeout`，规则的 `execution_timeout` 可覆盖 | `15m` | `executing` → `unknown`，`reason` 为 `execution_timeout`。`claim` 时开始计 |

`sweep` 扫描这三种期限。批准和认领如果发现期限已过，也会先写成对应的 `expired`，再拒绝本次操作。

请求上的 `expiresIn`（秒，1 到 7 天）若存在，代替这次请求的批准超时。

## 6. 强制式检查点

外部代理或凭证闸门 SHOULD 只放行处于 `executing` 的任务。当前 MCP 代理在把 `tools/call` 交给上游之前先 `claim`，使任务进入 `executing`。

## 7. `transitions.json` 格式

JSON 对象。键是源状态，值是目标状态数组。实现者 SHOULD 直接加载这个文件，并与 `TRANSITIONS` 保持一致。

## 一致性

校验器的 `state_machine` 步骤重建每个任务的迁移序列。`packages/core/test/states.test.ts` 把 `TRANSITIONS` 与 `transitions.json` 逐条比对。
