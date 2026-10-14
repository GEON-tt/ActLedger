[English](../payload.md) | [简体中文](payload.md)

# 载荷

## 事实来源

- `spec/payload.schema.json`
- `packages/core/src/payload.ts`（`normalizePayload`、`payloadHash`、`compareWithDrift`、`assertDriftPath`）
- `packages/core/src/secrets.ts` 的 `payloadCommit`
- `packages/core/src/engine.ts` 的 `finish` 和 `applyApproval`
- `packages/sdk/src/ledger.ts` 的 `ContentMismatch`
- 资料性参考：`packages/mcp-proxy/src/payload.ts`

和代码不一致时，以代码为准。

## 1. 结构

`$id` 是 `https://actledger.dev/schema/payload-0.1.json`。`additionalProperties` 为 `false`。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `action` | string | 是 | 动作类型，MUST 等于请求里的 `action.type` |
| `args` | object | 是 | 参数。MUST 是对象，MUST NOT 是数组 |
| `content` | object | 否 | schema 只要求它是对象。生产者使用的字段是 `content_type`，以及可选的 `text`、`ref`、`sha256` |
| `allowed_drift` | string 数组 | 否 | 执行时允许变化的路径 |

## 2. 规范化

`normalizePayload`：

1. `action` MUST 是非空字符串，否则 `400 invalid_request`。
2. `args` MUST 是非数组对象。
3. 输出对象先放 `action`、`args`。只有调用方提供了 `content` 才写入 `content`。只有提供了 `allowed_drift` 才写入它。
4. `allowed_drift` MUST 是数组，元素 MUST 是字符串，并且每条都通过 `assertDriftPath`。
5. 对结果调用 `jcs`。浮点数、`undefined`、bigint 和其他非 JSON 值在这里被拒绝。
6. 不补默认字段，不删空字符串，不改数组顺序。键顺序只在 JCS 时排序。

## 3. 哈希与承诺

0.1 的载荷哈希是无盐的 `payloadHash`：

```text
sha256: + SHA-256(jcs(normalizePayload(payload)))
```

0.2 的载荷哈希是加盐的 `payloadCommit`：

```text
hmac-sha256: + HMAC-SHA256(taskSalt, jcs(normalizePayload(payload)))
```

当前 `LedgerEngine` 只签发 0.2，因此新回执里的这三个字段都是 `hmac-sha256:`。校验器在 secrets 条目没有 `payload_salt` 时，按 0.1 的无盐 `payloadHash` 复算。

| 回执字段 | 对哪一份载荷 |
| --- | --- |
| `payload_hash` | 请求时提交的载荷。同一任务内 MUST 不变 |
| `approved_payload_hash` | 批准载荷。没有编辑时等于 `payload_hash`；有编辑时等于编辑后的载荷 |
| `executed_hash` | 执行方实际执行的载荷 |

## 4. `allowed_drift` 路径语法

`assertDriftPath` 拒绝时抛 `400 invalid_request`。路径 MUST：

- 非空，不以 `.` 开头或结尾，不含空段。
- 段名不是 `__proto__`、`prototype`、`constructor`。
- 至少两段，第一段是 `args` 或 `content`。

`args.signature` 合法。`action`、`args`、`body.x`、`args.` 不合法。分隔符是 `.`。

## 5. 比较语义

`compareWithDrift(approved, executed)`：

1. 路径取自批准载荷的 `allowed_drift`，缺省是空数组。每条路径先过 `assertDriftPath`。
2. `driftApplied` 是两侧查找结果不同的那些路径。找不到和找到 `undefined` 不算相同。值用 `jcs` 比较。
3. 两侧都先 `normalizePayload`，再删掉 `allowed_drift` 本身，再按路径删掉允许漂移的叶子，然后比较 JCS。
4. `match` 为真当且仅当剥掉之后的 JCS 相同。`allowed_drift` 本身不参与比较。

`defaults.content_mode` 是 `strict` 或 `warn`，默认 `strict`。它是整份策略的默认值，不是单条规则的字段。

- `strict`：`match` 为假时，任务进入 `failed`，`error.code` 为 `content_mismatch`，引擎抛 `422 content_mismatch`。SDK 把它包成 `ContentMismatch`。
- `warn`：`match` 为假时仍进入 `executed`，回执 `content_match` 为 `false`，`mismatch` 为 `true`，`drift_applied` 列出变化的路径。

SDK 的 `strictContent` 默认 `true`。它在调用完成之前再用 `compareWithDrift` 看一眼；不一致就先 `fail`，再抛 `ContentMismatch`。

## 6. 批准时编辑

`allow_edit` 默认 `true`。规则上的 `approval.allow_edit` 可以覆盖。

打开时，编辑后的载荷成为新的批准载荷：`approved_payload_hash` 改为编辑后的 `payloadCommit`，回执 `approval.edited_payload_hash` 记下同一个值。编辑后的 `action` MUST 仍等于任务的动作类型。

关闭时，提交 `editedPayload` MUST 被拒绝，错误是 `400 invalid_request`。

`approval.presented_hash` MUST 等于任务的 `payload_hash`，也就是批准人看到的那一版。

## 7. MCP 映射（资料性，非规范）

这一节描述当前 `@actledger/mcp-proxy`，可能随代理版本变化，校验器 MUST NOT 依赖它。

- `tools/call` 的 arguments 对象成为 `payload.args`。
- 配置了 `content.field` 且该字段是字符串时，它从 `args` 挪到 `payload.content`，`content_type` 来自映射。
- `allowedDrift` 原样写入 `payload.allowed_drift`。
- `attrs` 至少包含 `mcp_server` 和 `mcp_tool`。`attrsFrom` 可以把参数里的标量抄进属性。这两个保留键不能被映射覆盖。
- 指纹是 `sha256` 十六进制（无前缀），输入为 `jcs({ server, tool, args })`，用来去掉重复调用。

## 8. 示例

`scripts/gen-vectors.ts` 里的 `email.send` 载荷，`allowed_drift` 是 `args.signature`：

```json
{
  "action": "email.send",
  "args": { "to": ["bob@clienta.com"], "subject": "Re: 报价" },
  "content": { "content_type": "text/plain", "text": "hello" },
  "allowed_drift": ["args.signature"]
}
```

## 一致性

`receipts-chain-0.2.jsonl` 配合 `secrets-0.2.jsonl`，可以用条目里的 `payload_salt`（base64url）和载荷明文复算 `payload_hash`、`approved_payload_hash`、`executed_hash`。盐用 `payloadCommit`。校验器在 `secrets` 步骤做这件事；shred 过的条目不复算，也不失败。
