import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function externalNodeSqlite(): Plugin {
  return {
    name: "external-node-sqlite",
    enforce: "pre",
    resolveId(id) {
      if (id === "sqlite" || id === "node:sqlite") return { id: "node:sqlite", external: true };
      return null;
    },
  };
}

export default defineConfig({
  plugins: [externalNodeSqlite()],
  resolve: {
    alias: [
      { find: /^@actledger\/core$/, replacement: src("./packages/core/src/index.ts") },
      { find: /^@actledger\/sdk$/, replacement: src("./packages/sdk/src/index.ts") },
      { find: /^@actledger\/sdk\/webhook$/, replacement: src("./packages/sdk/src/webhook.ts") },
      { find: /^@actledger\/mcp-proxy$/, replacement: src("./packages/mcp-proxy/src/index.ts") },
      { find: /^@actledger\/claude-agent-sdk$/, replacement: src("./packages/claude-agent-sdk/src/index.ts") },
      { find: /^@actledger\/openai-agents$/, replacement: src("./packages/openai-agents/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "examples/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20_000,
  },
});
