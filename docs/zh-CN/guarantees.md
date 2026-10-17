[English](../en/guarantees.md) | [简体中文](guarantees.md)

# 保证边界

ActLedger 是 agent 应用主动接入的 SDK。没有经过 ActLedger 的动作不在保证范围内。经过了的动作，保证强度取决于检查在哪里运行。

| | 记录式（recorded） | 强制式（enforced） |
| --- | --- | --- |
| 检查在哪里运行 | 在 agent 进程里面 | 在它外面，位于 agent 和工具之间 |
| 本仓库里的实现 | ToolGate、`ledger.guard`、Claude Agent SDK 适配器、OpenAI Agents SDK 适配器 | MCP 代理，针对它暴露的工具。`executing` 之后才发放短期凭证的凭证闸门还没有做 |
| 谁持有真实连接或凭证 | agent | 代理 |
| 你得到什么 | 走过账本的调用按状态机走完，可以审批、可以校验，事后改这些回执能被发现 | 记录式的全部，并且这一类调用在账本认领之前不能执行 |
| 你得不到什么 | 模型或代码可以绕过被包住的工具，例如用 shell、通用 HTTP 客户端或浏览器 | 不经过代理的路径。网络和凭证隔离由部署方保证 |
| 回执上的 coverage | 你的 `coverage` glob 声明了什么，就记什么；没有匹配 glob 的动作记为 recorded | 代理为它暴露的工具加上 `mode: enforced`、`via: mcp-proxy` |

怎么选：

- 你自己持有 agent 循环，或框架没有适配器：[工具闸门](tool-gate.md)。Claude Agent SDK 或 OpenAI Agents SDK：用对应的适配器（[框架集成](integrations.md)）。这些是记录式。
- 工具是一台你不想让模型直接调用的 MCP 服务器：让它经 [MCP 代理](mcp-proxy.md) 启动。对代理暴露的工具，这是强制式。
- 两者可以共用一个账本目录。分步页面：[场景](scenarios/own-loop.md)。

两种模式都有两条限制。

哈希链证明记下来的回执没有被改。它不证明每个动作都记下来了。覆盖声明说明应用自称接入了哪些动作 glob、用的是哪种模式，并且写在回执上。ActLedger 不证明这份声明是完整的。

`complete` 上报的执行载荷来自 agent。这份上报的证据强度是 `E1`（`evidence_assurance`）。更强的证明是第三方编号或第三方签名。当前校验器不要求它们。

高于 `app_asserted` 的本地 CLI 批准，以及任何 step-up，都会标上 `approval.auth.simulated`。CLI 不做渠道登录，也不做 WebAuthn。校验器能看见这个标志。它不能把标志变成真实的身份确认。

网页和链接审批是 `app_asserted`，不代表渠道身份核验。

本地目录里 `master.key` 和 `ledger.db` 放在一起。这只适合开发，不是生产环境的密钥管理。

策略词汇里的高风险等级是 `send`、`spend`、`delete`。这类动作没有被任何 coverage glob 盖住时，加载会警告 `uncovered_high_risk`。警告不阻止动作。

也可看 [architecture.md](architecture.md)，以及 [spec/zh-CN/verify.md](../../spec/zh-CN/verify.md) 里的规范性规则。
