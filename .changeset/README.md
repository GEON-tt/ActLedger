# Changesets

七个发布包 `@actledger/core`、`@actledger/sdk`、`@actledger/cli`、`@actledger/mcp-proxy`、`@actledger/claude-agent-sdk`、`@actledger/openai-agents`、`@actledger/server` 在 `.changeset/config.json` 的 `fixed` 组里，版本始终一起变化。`examples/*` 是 private 包，不参与版本计算。

## 怎么写一个 changeset

在仓库根运行：

```bash
pnpm changeset
```

选择受影响的包，选择 `patch`、`minor` 或 `major`，再写一句面向用户的说明。命令会在 `.changeset/` 下生成一个 markdown 文件，和代码一起提交。只改文档或示例时可以不带 changeset。

## v1.0 之前的 semver

1.0.0 之前，minor 也可能不兼容。改变回执哈希或签名输入的修改必须标为 minor，并同时更新 `spec/` 和 `spec/test-vectors/`（用 `pnpm vectors` 重新生成后提交）。`verify` 必须一直能校验所有已发布的旧版本。

## 现在不发版

发版流程以后再定。不要运行 `changeset version` 或 `changeset publish`。
