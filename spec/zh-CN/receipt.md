[English](../receipt.md) | [简体中文](receipt.md)

# 回执

## 事实来源

- `spec/receipt.schema.json`（`$defs/v01`、`$defs/v02`、`actor`、`sig`、`transition`）
- `packages/core/src/receipts.ts`（`buildReceipt`、`unsignedReceipt`、`receiptHash`）
- `packages/core/src/canonical.ts`（`jcs`、`sha256Prefixed`、`commit`、`GENESIS_HASH`）
- `packages/core/src/crypto.ts`（Ed25519、`KeySet`、`PublicKeyRecord`）
- `packages/core/src/secrets.ts`（常量、`REASONS`、`payloadCommit`、`textCommit`、secrets 条目）
- `packages/core/src/time.ts`（`formatTimestamp`）
- `packages/core/src/ids.ts`
- `packages/core/src/verify.ts` 的 `keyValid`

和代码不一致时，以代码为准。

## 1. 概述

一条回执记录一次状态迁移，或者一条不进入任务状态机的账本事件（策略发布、覆盖声明、违规）。回执只能追加，按 `seq` 串成哈希链。当前 `buildReceipt` 写入的版本是 `actledger.receipt/0.2`。0.1 仍然 MUST 能被校验。

## 2. 数据类型约定

- 时间戳：生产者 MUST 使用 `formatTimestamp`，也就是 `Date.toISOString()`。形式是 ISO 8601 UTC，带毫秒，以 `Z` 结尾，例如 `2026-10-13T08:00:00.000Z`。校验器只要求 `issued_at` 是字符串；密钥退役用字符串比较，因此生产者 MUST 保持这一种格式。
- ID：`newId(prefix)` 是 `prefix` + `_` + 26 位 Crockford base32 ULID。本实现使用的前缀有 `app`、`tsk`、`rcp`、`sec`、`apr`、`vio`。校验器只要求 `id` 是字符串。
- 哈希：`sha256:` + 64 位小写十六进制（`SHA_RE`）。0.2 的 `hash` 和 `prev_hash` MUST 匹配。0.1 的 schema 只要求字符串。
- 承诺：`hmac-sha256:` + 64 位小写十六进制（`COMMIT_RE`）。
- 错误码：`^[a-z0-9_.]{1,64}$`（`ERROR_CODE_RE`）。
- 公钥和签名：base64url，无填充。公钥是 32 字节 Ed25519 原始公钥。

## 3. 顶层字段

0.1 和 0.2 的 `required` 相同，`additionalProperties` 为 `false`。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `v` | string | 是 | `actledger.receipt/0.1` 或 `actledger.receipt/0.2` |
| `id` | string | 是 | 回执 ID |
| `app_id` | string | 是 | 账本应用 |
| `seq` | integer ≥ 1 | 是 | 链上序号，从 1 连续 |
| `prev_hash` | string | 是 | 上一条的 `hash`。0.2 MUST 是 `sha256:` 哈希。第一条是创世哈希 |
| `task_id` | string 或 null | 是 | 任务 ID。非任务事件为 `null` |
| `transition` | object 或 null | 是 | `{ from, to }`。`from` 是字符串或 `null`。非任务事件为 `null` |
| `actor` | object | 是 | 谁写下这条回执 |
| `body` | object | 是 | 迁移内容。0.2 有额外限制 |
| `evidence` | array | 是 | `EvidenceRef` 数组，可以为空 |
| `issued_at` | string | 是 | 签发时间 |
| `hash` | string | 是 | 去掉 `hash` 和 `sig` 之后的回执哈希。0.2 MUST 是 `sha256:` 哈希 |
| `sig` | object | 是 | Ed25519 签名 |

`actor` 的 `additionalProperties` 为 `false`，必填 `type` 和 `id`。`type` 是 `agent`、`user`、`policy`、`system`。

`sig` 的 `additionalProperties` 为 `false`，必填 `alg`、`kid`、`value`。`alg` MUST 是 `Ed25519`。

`transition` 为对象时必填 `from` 和 `to`，`additionalProperties` 为 `false`。

## 4. 0.2 的 body 字段

schema 列出这些字段，并且禁止把 `note`、`description`、`result` 放在 body 顶层。body 本身没有 `additionalProperties: false`，所以实现还会写上下面表格之外的键。校验器禁止的是明文，不是未知键。

| 字段 | 语义 |
| --- | --- |
| `initiator.principal_id` | 负责人 |
| `initiator.agent_id` | 代理，可以为 `null` 然后被省略 |
| `initiator.intent_commit` | 意图的 `textCommit`。0.2 MUST NOT 出现 `initiator.intent` |
| `error.code` | 错误码，匹配 `ERROR_CODE_RE` |
| `error.message_commit` | 错误信息的 `textCommit`。MUST NOT 出现 `error.message` |
| `error.retryable` | 可选布尔 |
| `payload_hash` | 请求载荷的承诺，见 [payload.md](payload.md) |
| `approved_payload_hash` | 批准载荷的承诺 |
| `executed_hash` | 执行载荷的承诺 |
| `note_commit` | 拒绝、撤销或对账备注的 `textCommit` |
| `description_commit` | 违规描述的 `textCommit` |
| `reason` | 见下表 |
| `approval.presented_hash` | 批准人看到的 `payload_hash` |
| `approval.edited_payload_hash` | 批准时若编辑了载荷，这里是新的批准承诺 |

`reason` 按迁移目标状态分组，与 `REASONS` 一致：

| 目标状态 | 允许的 `reason` |
| --- | --- |
| `rejected` | `rejected_by_user`、`denied_by_policy` |
| `drafted` | `draft_only` |
| `expired` | `approval_timeout`、`claim_deadline` |
| `unknown` | `execution_timeout` |
| `revoked` | `revoked` |
| `failed` | `reconciled_not_executed` |

0.2 的 body MUST NOT 出现明文意图、错误信息或备注。具体地，MUST NOT 含有 `initiator.intent`、`note`、`description`、`result`、`approval.note`、`error.message`。`reason` 若出现，MUST 是上表里的枚举，不能是自由文本。

当前引擎还会在任务回执里写 `kind`（`task.transition`）、`action`、`policy`、`integration`、`drift_applied`、`content_match`、`mismatch`、`external_proofs`、`evidence_assurance`。这些字段参与哈希。校验器对其中与承诺、内容是否一致有关的关系做检查，见 [verify.md](verify.md)。

## 5. actor 与 evidence

`actor.type` 在 schema 里是 `agent`、`user`、`policy`、`system`。校验器的 `structure` 步骤只检查 `type` 和 `id` 是字符串。

`EvidenceRef`：

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `type` | 是 | 例如 `payload` |
| `sha256` | 是 | 字段名沿用旧称。0.2 的载荷证据在这里放 `hmac-sha256:` 承诺，由前缀区分算法 |
| `uri` | 否 | 证据位置 |
| `size` | 否 | 载荷证据是规范化 JSON 的 UTF-8 字节数 |
| `mime` | 否 | 载荷证据是 `application/json` |
| `captured_at` | 否 | 采集时间 |

`assurance` 三档，从低到高：`app_asserted`、`channel_verified`、`user_signed`。策略自动批准使用 `policy`，低于这三档。

`simulated`：本地 CLI 在保证高于 `app_asserted`，或声明了 step-up 时，把 `approval.auth.simulated` 设为 `true`。它表示这次批准没有真实的渠道身份确认。

`approval.channel` 取值 `cli`、`web` 或 `webhook_link`。`web` 和 `webhook_link` 恒为 `app_asserted`，且 `simulated: false`。

## 6. 规范化（JCS）

回执哈希和承诺都先做 `jcs`。实现覆盖 RFC 8785 的一个子集，并且拒绝子集以外的值。

1. 对象的键按 UTF-16 码元顺序排序，也就是 JavaScript 的字符串小于比较。
2. 对象和数组没有空白。
3. 数字只接受安全整数，序列化为 `String(value)`，不使用指数。浮点数、超出安全整数的数和 bigint 抛 `non_canonical_number`。
4. 字符串和键名使用 `JSON.stringify` 的转义。
5. `null`、布尔值按 JSON 字面量。
6. `undefined`、`Date`、`Map`、`Set`、类实例抛 `invalid_request`。原型为 `null` 的普通对象可以。

`spec/test-vectors/jcs.json` 有 7 组。其中：空对象得到 `{}`，空数组得到 `[]`，`null` 得到 `null`，`{"b":1,"a":2}` 得到 `{"a":2,"b":1}`，含 `é` 的对象按码元排序后 `a` 在前。带引号的字符串用例以该文件的最后一条为准，不要手写转义。

## 7. 承诺算法

```text
commit(salt, value) = "hmac-sha256:" + HMAC-SHA256(salt, utf8(jcs(value)))
```

salt 是该任务的 32 字节。salt 不进回执。

- `textCommit(salt, text)` 是 `commit(salt, text)`。消息是 JSON 字符串，带引号。意图和备注故意不做域分离：同一任务里相同的文本得到相同的承诺。
- `payloadCommit(salt, payload)` 是 `commit(salt, normalizePayload(payload))`。

`spec/test-vectors/commitments.json` 固定了 salt 的十六进制和四组 `string`、`object`、`zh`、`payload`。复算 MUST 等于文件里的 `commit`。

## 8. 载荷哈希

0.2 的载荷哈希按任务加盐。算法、三个字段分别覆盖哪一份载荷，见 [payload.md](payload.md)。

## 9. 回执哈希

`unsignedReceipt` 只保留：`v`、`id`、`app_id`、`seq`、`prev_hash`、`task_id`、`transition`、`actor`、`body`、`evidence`、`issued_at`。MUST NOT 把 `hash` 或 `sig` 算进去。

```text
hash = "sha256:" + SHA-256(utf8(jcs(unsignedReceipt)))
```

JCS 会重新排序键，因此未签名对象的插入顺序不影响哈希。

## 10. 签名

算法是 Ed25519。`buildReceipt` 传给 `Signer.sign` 的值是上面的 `hash` 字符串，不是 JCS 原文。Node 的 `sign(null, utf8(hash), privateKey)` 对这串 UTF-8 字节签名。`sig.value` 是签名的 base64url，无填充。

`kid` 的形式是 `<app_id>#<密钥名>`。本地 `init` 使用 `<app_id>#k<UTC 年份>a`，例如 `app_...#k2026a`。

`keys.json`：

```json
{
  "keys": [
    {
      "kid": "app_...#k2026a",
      "alg": "Ed25519",
      "public_key": "<32 字节原始公钥的 base64url>",
      "created_at": "2026-10-13T08:00:00.000Z",
      "retired_at": null
    }
  ]
}
```

`keyValid` 的有效期规则：

- `kid` MUST 存在于 `keys`。
- `retired_at` 为 `null` 时，不因时间拒绝。
- `retired_at` 是字符串时，`issued_at > retired_at` 则拒绝。比较是字符串比较。
- `created_at` 会写入 KeySet。`keyValid` 不要求 `issued_at` 晚于 `created_at`。

然后验证 Ed25519。

## 11. 哈希链

`seq` 从 1 开始，连续，不能有空档。第一条的 `prev_hash` MUST 等于 `GENESIS_HASH`，即 `sha256:` 加 64 个 `0`。之后每条的 `prev_hash` MUST 等于上一条的 `hash`。

## 12. secrets 文件（`actledger.secrets/0.1`）

JSONL，一行一条。空行跳过。secrets 文件含明文，MUST NOT 随回执公开分发。

`TaskSecretsEntry`：

| 字段 | 语义 |
| --- | --- |
| `v` | `actledger.secrets/0.1` |
| `kind` | `task` |
| `task_id` | 任务 |
| `principal_id` | 负责人 |
| `shredded` | 可选。crypto-shred 之后为 `true`，并且不再带 salt 和明文 |
| `payload_salt` | base64url 的 32 字节任务 salt。旧的无盐条目为 `null` |
| `intent` | 意图明文，可为 `null` |
| `payload` | 请求载荷 |
| `approved_payload` | 批准载荷，可与请求相同或为编辑后的对象 |
| `executed_payload` | 执行载荷 |
| `result` | 执行结果 |
| `error` | `{ code, message }` |
| `notes` | `{ reject, revoke, reconcile }`，值是字符串或 `null` |
| `proofs` | `{ index, type?, salt, value }`。`type` 在 schema-1 证明上可以没有 |

`ViolationSecretsEntry`：

| 字段 | 语义 |
| --- | --- |
| `v` | `actledger.secrets/0.1` |
| `kind` | `violation` |
| `receipt_id` | 违规回执 |
| `salt` | 这条描述自己的 salt，base64url |
| `description` | 明文描述 |

crypto-shred 删掉该 principal 的数据密钥。导出的任务条目只剩 `v`、`kind`、`task_id`、`principal_id`、`shredded: true`。校验器把它计入 `shredded`，不把它当成失败。

## 13. 0.1 与 0.2 的差异和兼容

0.1 可以带明文 `initiator.intent`，也可以带明文错误信息。向量里的 0.1 载荷哈希是无盐的 `sha256:`。0.2 MUST NOT 带这些明文，载荷哈希是加盐的 `hmac-sha256:`。

`verify` 遇到 0.1 明文只产生警告 `v01_plaintext`，`ok` 仍为 `true`。同一个任务 MUST NOT 混用两个版本，否则在 `version` 步骤失败。

## 14. 示例

下面这条 `executed` 回执原样来自 `spec/test-vectors/receipts-chain-0.2.jsonl` 的 seq 5：

```json
{"v":"actledger.receipt/0.2","id":"rcp_V02_0007","app_id":"app_01M4TZP16QSTEENC5EYCNF3AH9","seq":5,"prev_hash":"sha256:20f542cc31f73274d7730e016c89f7ea388aaf9a986797b2752ece8aa9fecd67","task_id":"tsk_V02_0001","transition":{"from":"executing","to":"executed"},"actor":{"type":"agent","id":"mail-agent"},"body":{"kind":"task.transition","initiator":{"principal_id":"u_1","agent_id":"mail-agent","intent_commit":"hmac-sha256:4e7301345b6e03743cf1ae62532e7d3a9161924e239e8832b22cbbc05a9576ec"},"action":{"type":"calendar.create","level":"write","blast_radius":"self","reversible":true},"policy":{"rule_id":"calendar-allow","policy_version":1,"ladder_level":0},"integration":{"mode":"recorded","coverage":"none","coverage_version":1},"payload_hash":"hmac-sha256:13d712a693131ebaad412aac2666c4fd914a1c3e3a8ae59fdd2f75b72841d4f8","approved_payload_hash":"hmac-sha256:13d712a693131ebaad412aac2666c4fd914a1c3e3a8ae59fdd2f75b72841d4f8","executed_hash":"hmac-sha256:13d712a693131ebaad412aac2666c4fd914a1c3e3a8ae59fdd2f75b72841d4f8","drift_applied":[],"content_match":true,"mismatch":false,"evidence_assurance":"E1","external_proofs":[]},"evidence":[],"issued_at":"2026-10-13T08:00:00.000Z","hash":"sha256:899f160f88f91ad1264d3b217de1f081675e578af3cb1173c23864b3f9a2933b","sig":{"alg":"Ed25519","kid":"app_01M4TZP16QSTEENC5EYCNF3AH9#k2026a","value":"Pm09DXxXTeloTVe6nmGJUhxCY8_OVXJbNTX-FjJOhlfC2WOl9YdKTrnOKJYibSJdIy4J_KwDmmimdSQxc4jwCg"}}
```

## 一致性

- `jcs.json`、`commitments.json`、`keys.json` 如上。
- `receipts-chain-0.1.jsonl`：5 条，`ok`，警告 `v01_plaintext`。
- `receipts-chain-0.2.jsonl`：`ok`。配合 `secrets-0.2.jsonl` 也 `ok`，且至少一条任务 secrets 为 shredded。
