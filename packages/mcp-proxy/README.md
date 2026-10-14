[English](https://github.com/GEON-tt/ActLedger/blob/main/packages/mcp-proxy/README.md) | [简体中文](#简体中文)

# @actledger/mcp-proxy

Wrap an upstream MCP server. Each `tools/call` is allowed, held for approval, or denied by policy, then written as a signed receipt.

```bash
npm install @actledger/mcp-proxy
npx actledger-mcp-proxy --ledger .actledger -- npx -y @modelcontextprotocol/server-filesystem .
```

Repository guide: <https://github.com/GEON-tt/ActLedger/blob/main/README.md>. Protocol: <https://github.com/GEON-tt/ActLedger/blob/main/spec/README.md>.

## 简体中文

包住上游 MCP 服务器。每次 `tools/call` 先按策略决定放行、等待批准或拒绝，再写入签名回执。

仓库说明：<https://github.com/GEON-tt/ActLedger/blob/main/README.zh-CN.md>。协议：<https://github.com/GEON-tt/ActLedger/blob/main/spec/zh-CN/README.md>。
