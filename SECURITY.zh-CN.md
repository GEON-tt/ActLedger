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
- 依赖漏洞

## 不在范围

下面这些是已声明的保证边界，不算漏洞。哈希链证明「记下来的没被改」，不证明「全都记下来了」。

- 记录式接入下，模型绕过包装工具
- 未接入的动作
- 本地 CLI 批准被标为 `simulated`
- `master.key` 与数据库放在同一目录（只适合开发）

## 致谢

报告人愿意的话，在发布说明里致谢。
