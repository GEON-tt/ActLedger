[English](../verify.md) | [简体中文](verify.md)

# 校验

## 事实来源

- `packages/core/src/verify.ts`（`verifyReceiptChain`、`verifyJsonl`、`VerifyReport`）
- `packages/cli/src/commands/export.ts` 的 `verifyCommand`
- `packages/cli/src/main.ts` 的命令行

和代码不一致时，以代码为准。

## 1. 输入

- 回执 JSONL。每行一条 JSON。空行跳过。校验器按 `seq` 升序处理，所以文件里的行序可以不是序号序，但序号本身 MUST 从 1 连续。
- KeySet，即 `keys.json`：`{ "keys": [ { kid, alg, public_key, created_at, retired_at } ] }`。
- 可选的 secrets JSONL，格式见 [receipt.md](receipt.md)。不提供时不做 `secrets` 步骤。

## 2. 输出

`VerifyReport`：

| 字段 | 语义 |
| --- | --- |
| `ok` | 没有失败步骤时为 `true`。警告不改变 `ok` |
| `failure` | 仅失败时出现。`step`、`reason`，以及该回执的 `id` 和 `seq` |
| `warnings[]` | 每项有 `code`、`message`、`count` |
| `stats.count` | 回执条数 |
| `stats.byVersion` | 按 `v` 计数 |
| `stats.byMode` | 按 `body.integration.mode` 计数 |
| `stats.byAssurance` | 按 `body.approval.assurance` 计数 |
| `stats.unknown` | `transition.to === "unknown"` 的条数 |
| `stats.violations` | `body.kind === "violation"` 的条数 |
| `stats.secrets` | 仅提供了 secrets 时出现：`checked`、`shredded`、`missing` |

空链的 `ok` 为 `true`。

## 3. 算法步骤

`verifyReceiptChain` 先按 `seq` 排序，收集统计和警告，然后按下面的顺序检查。遇到第一个失败就停止，`step` 使用该步的名字。

### 3.1 `structure`

对每一条调用 `checkStructure`：

- `v` MUST 是 `actledger.receipt/0.1` 或 `actledger.receipt/0.2`。
- `id`、`app_id` MUST 是字符串。`seq` MUST 是大于等于 1 的安全整数。
- `prev_hash`、`hash` MUST 是字符串。0.2 还 MUST 匹配 `sha256:` 加 64 位小写十六进制。
- `task_id` MUST 是字符串或 `null`。
- `transition` 为 `null`，或者 `from` 是字符串或 `null`、`to` 是字符串。
- `actor.type` 和 `actor.id` MUST 是字符串。
- `body` MUST 是对象，`evidence` MUST 是数组，`issued_at` MUST 是字符串。
- `sig.alg` MUST 是 `Ed25519`，`kid` 和 `value` MUST 是字符串。

### 3.2 `hash`

`receiptHash(unsignedReceipt(receipt))` MUST 等于 `hash`。不相等时 reason 为 `hash does not match the canonical receipt`。

### 3.3 `signature`

`keyValid`：

1. 按 `sig.kid` 找密钥。找不到则失败。
2. `retired_at` 非空且 `issued_at > retired_at`（字符串比较）则失败。`created_at` 会记在 KeySet 里，这一步不检查它。
3. 用该公钥对 `hash` 字符串做 Ed25519 验证。失败 reason 为 `signature mismatch`。

### 3.4 `chain`

排序后的第一条 `seq` MUST 是 1，`prev_hash` MUST 等于 `GENESIS_HASH`（`sha256:` 加 64 个 `0`）。之后每一条的 `seq` MUST 等于上一条加 1，`prev_hash` MUST 等于上一条的 `hash`。因此部分导出 MUST 从 seq 1 开始，否则在这一步失败。

### 3.5 `version`

同一个 `task_id` MUST NOT 混用 `0.1` 和 `0.2`。

### 3.6 `plaintext`

只检查 0.2。禁止 `initiator.intent`、顶层 `note`、`description`、`result`、`approval.note`、`error.message`。`reason` 若存在，MUST 是该目标状态允许的枚举。`error` 只允许 `code`、`message_commit`、`retryable`，并且 `code` 匹配 `^[a-z0-9_.]{1,64}$`，`message_commit` MUST 存在。

### 3.7 `commitments`

`checkCommitments`。承诺字段 MUST 匹配 `hmac-sha256:` 加 64 位十六进制。同一任务的 `payload_hash` 和 `intent_commit` MUST 保持不变。`payload` 证据的 `sha256` MUST 等于 `payload_hash`。`presented_hash` MUST 等于 `payload_hash`。`approved_payload_hash` MUST 等于 `edited_payload_hash`（若有）否则等于 `payload_hash`。`executing`、`executed`、`failed` 上的 `approved_payload_hash` MUST 等于批准那条回执。`executed_hash` 与 `approved_payload_hash` 的相等关系和 `content_match`、`drift_applied` 必须一致，见 [state-machine.md](state-machine.md)。

### 3.8 `state_machine`

按任务、按 `seq` 重建迁移。第一条 MUST 从 `null` 到 `prepared`。之后每一步 MUST 是合法迁移，MUST NOT 从终态离开，claim MUST NOT 超过一次，终态 MUST NOT 超过一个。

### 3.9 `semantics`

`checkSemantics`：已执行回执必须标明 `content_match` 或 `mismatch`；批准的保证等级、step-up 和 `decided_at` 见 [state-machine.md](state-machine.md)。

### 3.10 `secrets`

只在提供了 secrets 时执行。用 salt 复算承诺。`shredded: true` 的任务计入 `shredded`，跳过复算，不算失败。找不到条目计入 `missing`，也不算失败。明文和承诺不一致才失败。

0.2 任务 salt 是 `payload_salt` 的 base64url。没有 `payload_salt` 的旧条目用无盐 `payloadHash`。违规回执用该条目自己的 salt 对 `description` 做 `textCommit`，对照 `description_commit`。

## 4. 警告

`v01_plaintext`：0.1 回执的 `initiator` 含 `intent`，或 `error` 含 `message`，或 body 含 `note`，或 `reason` 不是该目标状态的枚举。消息是 `含明文意图或错误信息`。`count` 是这类回执的条数。

警告 MUST NOT 把 `ok` 改成 `false`。

## 5. CLI 行为

```text
actledger verify <file> --keys <keys.json> [--secrets <file>] [--json]
```

- 成功退出码 0，失败退出码 1。
- 成功时 stdout 一行：`OK <count> receipts  unknown=<n> violations=<n>`，提供了 secrets 时再加 ` secrets=<checked>/<shredded>/<missing>`。
- 失败时 stderr：`FAIL seq=<seq> step=<step> <reason>`。
- 每条警告写到 stderr：`WARN <code>: <message> (<count>)`。0.1 向量因此会有警告，退出码仍是 0。
- `--json` 把整个 `VerifyReport` 打到 stdout，不打人类可读的 OK 行。

`node:sqlite` 可能在 stderr 写 `ExperimentalWarning`。调用方 MUST NOT 把 stderr 非空当成失败。

## 6. 校验器能证明什么，不能证明什么

能证明：已提交的回执没有被篡改，签名在密钥未退役时有效，同一任务的迁移合法，0.2 没有明文，提供 secrets 时承诺和明文一致。

不能证明：所有动作都记录了；`assurance` 背后的身份是真的。本地 CLI 可以把高于 `app_asserted` 的批准标成 `simulated`。

## 7. 一致性

| 向量 | 期望 |
| --- | --- |
| `jcs.json` | 每个 `value` 的 JCS 等于 `jcs` |
| `commitments.json` | 用 `salt_hex` 复算，等于每条 `commit` |
| `keys.json` | 同时含 0.1 和 0.2 链的公钥 |
| `receipts-chain-0.1.jsonl` | `ok`，5 条，警告 `v01_plaintext` |
| `receipts-chain-0.2.jsonl` | `ok` |
| 同上加 `secrets-0.2.jsonl` | `ok`，`checked > 0`，`shredded >= 1` |

### 篡改样例

篡改样例由测试在运行时生成，没有作为文件提交。例如改动一条已签名回执的 body 字段，或改一个字节，并且不重算 `hash`：期望在 `hash` 步骤失败。删掉中间序号则在 `chain` 步骤失败。改 secrets 里的执行载荷或意图明文，期望在 `secrets` 步骤失败。

Python 实现在 `python/`，用同一套向量和 `scripts/verify-parity.ts` 对拍。
