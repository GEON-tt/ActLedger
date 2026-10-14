import fs from "node:fs";
import path from "node:path";
import { initLocalDir } from "@actledger/core";
import { CHANNELS_EXAMPLE } from "../serve/channels.js";
import { loadOrCreateLinkKey } from "../serve/links.js";

export function initCommand(opts: { dir: string; policy?: string }): void {
  const policyYaml = opts.policy ? fs.readFileSync(opts.policy, "utf8") : undefined;
  const created = initLocalDir(opts.dir, policyYaml ? { policyYaml } : undefined);
  const abs = path.resolve(opts.dir);
  const channelsPath = path.join(abs, "channels.yaml");
  fs.writeFileSync(channelsPath, CHANNELS_EXAMPLE, { flag: "wx", mode: 0o644 });
  loadOrCreateLinkKey(abs);
  process.stdout.write(`initialized ${abs}\napp ${created.appId}\n`);
  process.stdout.write(`channels ${channelsPath} (commented example)\n`);
  if (created.warnings.length > 0) {
    for (const warning of created.warnings) process.stderr.write(`warning: ${warning.message}\n`);
  }
  process.stderr.write("next: actledger dev --once   or   actledger tasks\n");
}
