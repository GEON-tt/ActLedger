[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# 参与贡献

## 开发环境

需要 Node.js 22.13 或更新，以及 pnpm 9。启用 Corepack 后安装依赖：

```bash
corepack enable
pnpm install
```

Python 测试需要 Python 3.10 或更新：

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
python/.venv/bin/pytest python -q
```

## 常用命令

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
pnpm actledger ...
```

`pnpm test` 和 `pnpm typecheck` 直接跑 TypeScript 源码，不需要先 `pnpm build`。`pnpm pack:check` 会构建、打包并联网安装 tarball，不包含在 `pnpm test` 里。

## DCO

每个 commit 都必须带 `Signed-off-by: Name <email>`。用 `git commit -s` 生成。

签名表示：你有权以 Apache-2.0 提交这段代码。本仓库不签 CLA。

漏签时，对尚未推送的提交用 `git commit --amend -s` 补上；对多个提交用 `git rebase --signoff`。

Developer Certificate of Origin 1.1 全文如下，也可看 <https://developercertificate.org/>。

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## 变更集

影响发布包（`@actledger/core`、`@actledger/sdk`、`@actledger/cli`、`@actledger/mcp-proxy`）的 PR 要带 `pnpm changeset`。只改文档或示例可以不带。写法见 [`.changeset/README.md`](.changeset/README.md)。

## 规范变更

改 `spec/`、回执字段、哈希或签名输入、状态迁移的 PR，要同步更新 schema、`spec/*.md`、`spec/zh-CN/*.md` 和 `spec/test-vectors/`。测试向量用 `pnpm vectors` 重新生成后提交。向量里的密钥是随机的，重新生成后签名会变。

对外格式的变更走 RFC：在 `spec/rfcs/` 下提 PR，至少公开讨论 7 天。

v1.0 之前，minor 也可能不兼容。`verify` 必须一直能校验所有已发布的旧版本。v1.0 之后只允许加可选字段；改变哈希或签名输入就升 major。

## 安全相关改动的审阅

涉及规范化、承诺、签名、校验或状态机的改动，至少要有一名维护者以外的人 review。第一年做不到时，在 PR 里标注「仅维护者审阅」。

## 代码风格

跟随周围代码。TypeScript 使用 strict 模式。`packages/*/src` 里的相对 import 必须带 `.js` 后缀。新功能要带测试。

## 插件

插件可以放在独立仓库，由贡献者自行维护。主仓 README 的「社区插件」列表通过 PR 申请加入。

## 安全问题

不要提公开 issue。见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。
