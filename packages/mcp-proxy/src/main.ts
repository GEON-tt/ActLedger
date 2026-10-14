#!/usr/bin/env node
import { LedgerError } from "@actledger/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./args.js";
import { loadProxyConfig, resolveConfig } from "./config.js";
import { createProxy } from "./proxy.js";

function help(): void {
  process.stdout.write(`actledger-mcp-proxy — stdio MCP proxy that records each tools/call in ActLedger

  actledger-mcp-proxy --ledger .actledger --upstream "node server.js"
  actledger-mcp-proxy --ledger .actledger --config proxy.config.yaml
  actledger-mcp-proxy --ledger .actledger -- node server.js --flag

Options:
  --ledger <dir>          Ledger directory
  --upstream "<cmd>"      Upstream command, split without a shell
  --upstream-cwd <dir>    Working directory for the upstream process
  --config <file>         YAML or JSON proxy config
  --principal <id>        Task principal (default local-user)
  --name <id>             Upstream name stored as attrs.mcp_server
  --approval-wait <ms>    Synchronous approval wait, 0..30000
  --help
`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    help();
    return;
  }
  const file = cli.config ? loadProxyConfig(cli.config) : undefined;
  const config = resolveConfig(cli, file);
  const proxy = await createProxy({ config });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await proxy.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.stdin.on("end", () => {
    void shutdown();
  });
  process.stdin.on("close", () => {
    void shutdown();
  });
  await proxy.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  if (error instanceof LedgerError) {
    process.stderr.write(`error: ${error.code}: ${error.message}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: internal: ${message}\n`);
  }
  process.exit(1);
});
