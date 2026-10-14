import fs from "node:fs";
import path from "node:path";
import { initLocalDir } from "@actledger/core";

export function initCommand(opts: { dir: string; policy?: string }): void {
  const policyYaml = opts.policy ? fs.readFileSync(opts.policy, "utf8") : undefined;
  const created = initLocalDir(opts.dir, policyYaml ? { policyYaml } : undefined);
  process.stdout.write(`initialized ${path.resolve(opts.dir)}\napp ${created.appId}\n`);
  if (created.warnings.length > 0) {
    for (const warning of created.warnings) process.stderr.write(`warning: ${warning.message}\n`);
  }
  process.stderr.write("next: actledger dev --once   or   actledger tasks\n");
}
