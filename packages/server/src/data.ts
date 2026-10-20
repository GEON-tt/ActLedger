import fs from "node:fs";
import path from "node:path";
import { LedgerError, initLocalDir, type PolicyWarning } from "@actledger/core";
import { CredentialStore } from "./store.js";

export function resolveDataDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(flag ?? env.ACTLEDGER_DATA ?? "./actledger-data");
}

export function ledgerDir(data: string): string {
  return path.join(data, "ledger");
}

export function serverDbPath(data: string): string {
  return path.join(data, "server.db");
}

export function initServerData(
  data: string,
  opts?: { policyYaml?: string },
): { appId: string; data: string; warnings: PolicyWarning[] } {
  const root = path.resolve(data);
  if (fs.existsSync(serverDbPath(root)) || fs.existsSync(path.join(ledgerDir(root), "app.json"))) {
    throw new LedgerError("invalid_request", `${root} is already initialized`, 400);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const created = initLocalDir(ledgerDir(root), opts?.policyYaml ? { policyYaml: opts.policyYaml } : undefined);
  const store = CredentialStore.open(serverDbPath(root));
  store.close();
  return { appId: created.appId, data: root, warnings: created.warnings };
}

export function assertInitialized(data: string): void {
  const root = path.resolve(data);
  if (!fs.existsSync(serverDbPath(root)) || !fs.existsSync(path.join(ledgerDir(root), "app.json"))) {
    throw new LedgerError(
      "not_found",
      `${root} is not an actledger-server data directory; run actledger-server init`,
      404,
    );
  }
}
