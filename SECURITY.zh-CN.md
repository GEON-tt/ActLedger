[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

# 安全政策

## 支持的版本

现阶段只修 0.1.x 最新版。v1.0 之前不做向后移植。

## 私下报告

不要开公开 issue，也不要在讨论区贴利用细节。

- 首选：[GitHub Private vulnerability reporting](https://github.com/GEON-tt/ActLedger/security/advisories/new)（仓库 Security 页里的 Report a vulnerability）。
- 备用邮箱：`zh1751259510@gmail.com`。

## 响应时限

- 3 个工作日内确认收到。
- 7 天内给出初步评估。
- 目标 90 天内修复并协调披露。修复前不公开细节。

## 范围

以下问题属于安全漏洞：

- 回执伪造、哈希链或签名绕过
- JCS 规范化歧义
- 承诺被反推出明文
- 状态机能被绕过（例如重复 claim、`executing` 被重放）
- 策略求值越权
- MCP 代理被绕过后仍报告 `enforced`
- `secrets` 文件或 `master.key` 泄露路径
- agent key 能调用审批或导出，或能跨 principal 访问
- 绕过 TOTP 或审批人会话
- 远端审批台的 CSRF 或 `Origin` 绕过
- 依赖漏洞

## 不在范围

下面这些是已声明的保证边界，不算漏洞。哈希链证明「记下来的没被改」，不证明「全都记下来了」。

- 记录式接入下，模型绕过包装工具
- 未接入的动作
- 本地 CLI 批准被标为 `simulated`
- `master.key` 与数据库放在同一目录（只适合开发）
- 同一系统用户下的本地 agent 读 `serve.token` 或跑 CLI 来自己批准
- 服务器运营方改账本。要发现这一点需要外部锚定
- agent 已经持有真实服务凭证，并绕过 ActLedger 直接调用服务。要挡住这一点需要 credential gate
- 登录限流把成功也算进去。同一 IP 15 分钟 20 次（含成功）可能挡住同一个 NAT 后面的其他人。校验前先计数，是为了不让并发请求绕过限额
- 审批人会话上的 `GET /v1/export` 返回整条链，不按 principal 过滤。回执里是承诺。明文留在服务器 secrets 区，不导出。principal 要隔离时用多个服务器
- 已存在的用户名失败 5 次后返回 `429` 和 `Retry-After`，未知用户名用另一套计数，响应差异可能暴露用户名是否存在。用户名不是秘密。门槛仍然是密码和验证器码

## 致谢

报告人愿意的话，在发布说明里致谢。
