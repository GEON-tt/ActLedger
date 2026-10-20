[English](../README.md) | [简体中文](README.md)

# ActLedger 规范

## 事实来源

本目录描述当前实现必须遵守的对外格式。和代码不一致时，以代码行为为准改文档，不改协议行为。结构概要见 [docs/zh-CN/architecture.md](../../docs/zh-CN/architecture.md) 与 [docs/en/architecture.md](../../docs/en/architecture.md)。本目录给出可以独立实现校验器的规则。

## 1. 范围与读者

读者是回执校验器、账本实现和策略引擎的作者。

本目录规定校验器或兼容服务器要实现的格式：字段、算法、状态迁移、HTTP API，以及期望的测试向量。单租户 HTTP API 在 [http.md](http.md)。

## 2. 文件清单

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [receipt.md](receipt.md)、[receipt.schema.json](../receipt.schema.json) | 回执 0.1 / 0.2、哈希、签名、secrets | 当前 |
| [payload.md](payload.md)、[payload.schema.json](../payload.schema.json) | 动作载荷、漂移、承诺 | 当前 |
| [state-machine.md](state-machine.md)、[transitions.json](../transitions.json) | 任务状态和合法迁移 | 当前 |
| [policy.md](policy.md) | 策略文档和求值 | 当前；还没有 `policy.schema.json` |
| [verify.md](verify.md) | 校验器步骤和 CLI | 当前 |
| [rpc.md](rpc.md) | 本地 stdio rpc，供 Python SDK 调用 | 当前 |
| [http.md](http.md) | 单租户 HTTP API | 当前 |
| [test-vectors/](../test-vectors/) | 固定向量 | 当前 |

## 3. 规范性用语

关键字 MUST、MUST NOT、SHOULD、SHOULD NOT、MAY 按 RFC 2119 和 RFC 8174 解释。

## 4. 标识符与版本

已发布的标识：

| 标识 | 代码常量 | 含义 |
| --- | --- | --- |
| `actledger.receipt/0.1` | `RECEIPT_V01` | 回执 0.1 |
| `actledger.receipt/0.2` | `RECEIPT_V02` | 回执 0.2 |
| `actledger.secrets/0.1` | `SECRETS_V` | secrets JSONL |
| `https://actledger.dev/schema/payload-0.1.json` | `payload.schema.json` 的 `$id` | 载荷 schema |
| 策略 `version: 1` | `policyDocumentSchema` | 策略文档 |

v1.0 之前，minor 也可能不兼容。`verify` MUST 能校验所有已发布的旧版本。v1.0 之后只允许增加可选字段；改变哈希或签名输入 MUST 升 major。

## 5. 术语

- **App**：一个账本实例，有 `app_id` 和签名密钥。
- **Principal**：动作的负责人，`principal_id`。
- **Agent**：发起或执行动作的代理，`agent_id`。
- **Task**：一次动作从 `prepared` 走到终态的记录。
- **Action**：动作类型及其属性。
- **Payload**：交给执行方的参数对象。
- **Receipt**：一次状态迁移的追加记录，带哈希和签名。
- **Actor**：写下这条回执的主体。
- **EvidenceRef**：回执上的证据引用。
- **Assurance**：批准时的身份保证等级。
- **Coverage**：`recorded`（记录式）或 `enforced`（强制式）。
- **Commitment**：用任务 salt 对明文做的 HMAC。
- **Salt**：每个任务 32 字节，只放在 secrets 里，不进回执。
- **Secrets 文件**：承诺对应的明文，JSONL，不随回执公开分发。
- **Crypto-shred**：删掉主体密钥，使该主体的 secrets 无法再解密。

## 6. 测试向量

向量由 `scripts/gen-vectors.ts` 生成。密钥是随机的，重新生成后签名会变。CI 只校验已经提交的向量，不重新生成再 diff。

| 文件 | 用途 | 期望 |
| --- | --- | --- |
| `jcs.json` | `value` 到 JCS 字符串 | `jcs(value)` 等于 `jcs` |
| `commitments.json` | salt 加 value 到 commit | `commit(salt, value)` 等于 `commit` |
| `keys.json` | KeySet | `keys[]` 每项有 `kid`、`alg`、`public_key`、`created_at`、`retired_at` |
| `receipts-chain-0.1.jsonl` | 0.1 链，5 条回执 | `ok`，警告 `v01_plaintext` |
| `receipts-chain-0.2.jsonl` | 0.2 链 | `ok` |
| `secrets-0.2.jsonl` | 配合 0.2 链 | `ok`，其中至少 1 个任务已 shred |

## 7. 保证边界

哈希链证明「记下来的没被改」，不证明「全都记下来了」。没接入的动作不在保证范围内。记录式接入不能阻止调用方绕过包装工具。强制式接入把检查放在进程外面。

## 8. 变更流程

对外格式的变更在 `spec/rfcs/` 提 PR，公开讨论至少 7 天，并同步更新 schema、本目录的说明和 `test-vectors/`。改变回执哈希或签名输入的修改，在 v1.0 之前标为 minor。

## 9. 尚未覆盖

HTTP API、RFC 3161 锚定、`policy.schema.json`。

## 一致性

本文件第 6 节的期望与 `packages/core/test/vectors.test.ts`、`packages/core/test/canonical.test.ts` 一致。0.1 向量是 5 条 `actledger.receipt/0.1`，`ok === true`，警告码 `v01_plaintext`。0.2 向量在不提供 secrets 时 `ok === true`；提供 `secrets-0.2.jsonl` 时 `ok === true`，`secrets.checked > 0`，`secrets.shredded >= 1`。
