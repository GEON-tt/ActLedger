[English](../policy.md) | [简体中文](policy.md)

# 策略

## 事实来源

- `packages/core/src/policy/schema.ts`（`policyDocumentSchema` 是现在唯一的规范定义；还没有 `policy.schema.json`）
- `packages/core/src/policy/load.ts`
- `packages/core/src/policy/evaluate.ts`
- `packages/core/src/policy/match.ts`
- `packages/core/src/default-policy.ts`

和代码不一致时，以代码为准。

## 1. 文档结构

策略是 YAML。顶层经 `policyDocumentSchema` 解析。

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `version` | 是 | MUST 是整数 `1` |
| `defaults` | 否 | 缺省时用第 2 节的默认值 |
| `coverage` | 否 | 覆盖声明数组 |
| `actions` | 否 | 动作目录，键是动作类型 |
| `rules` | 否 | 有序规则 |

zod object 默认剥离未知键，不因此报错。已知键类型不对、YAML 解析失败、时长或时区非法，都抛 `422 policy_invalid`。

## 2. defaults

| 字段 | 取值 | 缺省 |
| --- | --- | --- |
| `unknown_action` | `allow`、`require_approval`、`deny`、`draft_only` | `require_approval` |
| `timezone` | IANA 时区名，MUST 能被 `hourInTimeZone` 接受 | `UTC` |
| `content_mode` | `strict` 或 `warn` | `strict` |
| `approval` | 见第 4 节 | 各子字段用第 4 节的缺省 |
| `claim_deadline` | 时长 | `24h` |
| `execution_timeout` | 时长 | `15m` |

时长 MUST 匹配 `^(\d+)(ms|s|m|h|d)$`。

## 3. actions 与授权阶梯

`level` MUST 是 `ACTION_LEVELS` 之一：`read`、`draft`、`write`、`send`、`spend`、`delete`。

高风险等级是 `HIGH_RISK_LEVELS`：`send`、`spend`、`delete`。

可选字段：

- `blast_radius`：`self`、`others`、`public`。求值时请求自己的值优先，否则用目录，再否则 `self`。
- `reversible`：布尔。同样是请求优先，否则目录，再否则 `true`。

高风险动作如果没有任何 `coverage` 条目的 `action` glob 命中它，加载时产生警告 `uncovered_high_risk`，不拒绝加载。

## 4. approval 对象

`defaults.approval` 和 `require_approval` 规则的 `approval` 使用同一形状。

| 字段 | 缺省 | 继承 |
| --- | --- | --- |
| `channels` | `[]` | 规则对象里出现该键就替换，包括空数组 |
| `timeout` | `15m` | 同上。MUST 是合法时长 |
| `allow_edit` | `true` | 同上 |
| `min_assurance` | `app_asserted` | 同上。MUST 是 `app_asserted`、`channel_verified`、`user_signed` |
| `step_up` | `null`（字段省略时） | 规则里显式写出才替换，包括 `null` |

**强制。** `approve` 和 `reject` 带一个渠道（CLI 是 `cli`，`actledger serve` 是 `web`，签名链接是 `webhook_link`）。引擎只在该渠道属于任务合并后的 `channels` 时接受决定。空列表表示 `[cli]`。否则返回 `403 channel_not_allowed`，并且不写回执。列表在任务创建时固定。回执记录 `approval.channel`，但不记录允许列表，所以 `verify` 不复核它。

`step_up` 是下列之一：

- 非空字符串，表示方法名，例如 `webauthn`。
- `{ when, method }`。`when` 用第 6 节的匹配对象，命中时方法名生效，否则这一次决策没有 step-up。
- `null`，表示不要 step-up。

`defaults.approval.step_up` 是合法默认值。`require_approval` 规则没有自己的 `step_up` 时继承它。求值只在 `effect` 为 `require_approval` 时把合并结果放进决策；`allow` 决策的 step-up 是 `null`。

在 `allow`、`deny`、`draft_only` 规则上写 `approval`（包括只写 `step_up`）会在加载时抛 `422 policy_invalid`，原因是 `rules.<id>.approval is only allowed on require_approval rules`。写在 `defaults.approval` 上的 `step_up` 不会被拒绝。

## 5. rules

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `id` | 是 | 非空，全文 MUST 唯一 |
| `match` | 是 | 匹配对象。多键是 AND |
| `effect` | 是 | `EFFECTS`：`allow`、`require_approval`、`deny`、`draft_only` |
| `approval` | 否 | 只允许出现在 `require_approval` |
| `execution_timeout` | 否 | 覆盖默认执行超时 |
| `ladder.promote_hint` | 否 | 原样放进决策，本轮不自动提升 |
| `ladder.demote_on` | 否 | 字符串数组，本轮求值不读取 |

规则按数组顺序尝试。第一条命中的规则生效。

## 6. match 语法

以 `match.ts` 为准。可解析的路径：

| 路径 | 值 |
| --- | --- |
| `action` | 动作类型字符串 |
| `level` | 目录里的 level；动作未声明时该路径不存在 |
| `attrs.<键>` | 请求属性 |
| `amount.value`、`amount.currency` | 金额。金额必须是安全整数，货币是 3 个大写字母 |
| `time.hour` | 策略时区下的小时，0–23 |
| `grant.ladder_level` | 当前阶梯，本轮固定为 0 |
| `principal.tags` | 主体标签，本轮默认空数组 |

不认识的路径视为不存在。它不会在加载时被拒绝，但在求值时这条子句失败，整条规则不命中。

期望值有两种写法：

- 标量：路径存在且 `===` 相等。`action: email.send` 是全字匹配，`*` 不会展开。
- 运算符对象，键 MUST 属于 `in`、`not_in`、`gt`、`gte`、`lt`、`lte`、`between`、`not_between`、`glob`、`exists`。一个对象里的运算符是 AND。

`glob` 使用 `globMatch`：没有 `*` 时全字相等；`*` 变成 `.*`，其余正则字符转义，并且匹配整串。`email.*` 能匹配 `email.send`。

`time.hour` 的 `between` 和 `not_between` 是闭区间 `[low, high]`，两端都是数。`not_between: [9, 20]` 表示小时小于 9 或大于 20 才命中。

多个键之间是 AND。空的 `match: {}` 匹配一切。加载时会检查运算符形状和整数范围；不认识的运算符抛 `422 policy_invalid`。

## 7. 求值语义

1. 用 `defaults.timezone` 算出 `time.hour`。
2. 按顺序找第一条命中的规则。
3. 没有规则命中时，已声明和未声明的动作都使用 `defaults.unknown_action`。差别只在目录：已声明的动作有 `level`，因此高风险的 `min_assurance` 下限和 `level` 匹配仍然有效。规则 id 记为 `default:<effect>`。
4. `effect` 决定下一状态：`allow` → `approved`，`require_approval` → `pending_approval`，`deny` → `rejected`，`draft_only` → `drafted`。
5. `step_up` 只对 `require_approval` 生效，算法见第 4 节。`defaults.approval.step_up` 是这个效果的默认值，不是加载错误。
6. `min_assurance` 只对 `require_approval` 有值，其他效果是 `null`。规则写了 `min_assurance` 就用它。否则若 level 属于高风险，而默认保证低于 `channel_verified`，则抬到 `channel_verified`；默认已经不低于它时保留默认。再否则用默认值。
7. 比较用 `assuranceRank`：`policy` 0，`app_asserted` 1，`channel_verified` 2，`user_signed` 3。批准时得到的等级 MUST 大于等于要求的等级。
8. `time.hour` 使用 `defaults.timezone`。非法时区在加载时抛 `422 policy_invalid`。

## 8. assurance 等级

`app_asserted` 低于 `channel_verified`，低于 `user_signed`。策略自动批准使用 `policy`，低于这三档。

本地 CLI 在保证高于 `app_asserted`，或使用 `--step-up` 时，把回执标成 `simulated: true`。CLI 并不做真实的渠道身份确认，也不收集 WebAuthn 断言。校验器要求非空的 step-up 带 `simulated: true`。

## 9. coverage 声明

每条：

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `action` | 是 | glob，规则同 `globMatch` |
| `mode` | 是 | `recorded` 或 `enforced` |
| `via` | 否 | 说明从哪接入 |

第一条 glob 命中的条目生效。没有命中时模式是 `recorded`，`coverage` 记为 `none`。

MCP 代理在运行时把每个暴露工具对应的动作叠成 `mode: enforced`、`via: mcp-proxy` 的 overlay，插在策略文件里的 `coverage` 前面。它不改 `policy.yaml`。

## 10. 加载警告

`PolicyWarning.code` 有两个值：

| code | 当前是否发出 |
| --- | --- |
| `uncovered_high_risk` | 是。高风险动作没有被任何 coverage glob 覆盖 |
| `high_risk_low_assurance` | 类型里有这个码。`validatePolicy` 目前不发出它 |

警告不阻止加载。

## 11. 示例

`DEFAULT_POLICY` 全文：

```yaml
version: 1
defaults:
  unknown_action: require_approval
  timezone: UTC
  content_mode: strict
  approval:
    channels: [cli, web]
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

## 一致性

行为由 `packages/core/test/policy.test.ts` 覆盖。以后会补 `policy.schema.json`；在那之前，zod schema 是唯一的机器可读定义。
