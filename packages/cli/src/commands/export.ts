import fs from "node:fs";
import { checkReceipt, LedgerError, openLedger, parseSecretsJsonl, serializeSecrets, verifyJsonl, type KeySet } from "@actledger/core";

export function exportCommand(opts: { dir: string; from?: number; to?: number; secrets?: string }): void {
  const engine = openLedger({ dir: opts.dir });
  try {
    for (const receipt of engine.exportReceipts(opts.from, opts.to)) {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    }
    if (opts.secrets) {
      const text = serializeSecrets(engine.exportSecrets(opts.from, opts.to));
      try {
        fs.writeFileSync(opts.secrets, text, { flag: "wx", mode: 0o600 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          throw new LedgerError("invalid_request", `secrets file already exists: ${opts.secrets}`, 400);
        }
        throw error;
      }
      fs.chmodSync(opts.secrets, 0o600);
      process.stderr.write("secrets 文件含解密原文\n");
    }
  } finally {
    engine.close();
  }
}

export function verifyCommand(opts: { file: string; keys: string; secrets?: string; json: boolean }): number {
  const text = fs.readFileSync(opts.file, "utf8");
  const keys = JSON.parse(fs.readFileSync(opts.keys, "utf8")) as KeySet;
  const secrets = opts.secrets ? parseSecretsJsonl(fs.readFileSync(opts.secrets, "utf8")) : undefined;
  const report = verifyJsonl(text, keys, secrets ? { secrets } : undefined);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.ok) {
    const secretStats = report.stats.secrets
      ? ` secrets=${report.stats.secrets.checked}/${report.stats.secrets.shredded}/${report.stats.secrets.missing}`
      : "";
    process.stdout.write(
      `OK ${report.stats.count} receipts  unknown=${report.stats.unknown} violations=${report.stats.violations}${secretStats}\n`,
    );
  } else {
    process.stderr.write(
      `FAIL seq=${report.failure?.seq ?? "-"} step=${report.failure?.step} ${report.failure?.reason}\n`,
    );
  }
  for (const warning of report.warnings) {
    process.stderr.write(`WARN ${warning.code}: ${warning.message} (${warning.count})\n`);
  }
  return report.ok ? 0 : 1;
}

export function showCommand(opts: { dir: string; id: string }): void {
  const engine = openLedger({ dir: opts.dir });
  try {
    const receipt = engine.getReceipt(opts.id);
    if (!receipt) {
      process.stderr.write(`receipt ${opts.id} not found\n`);
      process.exitCode = 1;
      return;
    }
    const check = checkReceipt(receipt, engine.publicKeys());
    const transition = receipt.transition ? `${receipt.transition.from ?? "∅"} → ${receipt.transition.to}` : receipt.body.kind;
    const lines = [
      `回执 ${receipt.id}  seq ${receipt.seq}`,
      receipt.issued_at,
      `迁移: ${transition}`,
      `动作: ${String((receipt.body.action as { type?: string } | undefined)?.type ?? "-")}`,
      `接入: ${String((receipt.body.integration as { mode?: string } | undefined)?.mode ?? "-")}`,
      `批准: ${String((receipt.body.approval as { assurance?: string } | undefined)?.assurance ?? "-")}`,
      `内容一致: ${String(receipt.body.content_match ?? "-")}`,
      `哈希: ${receipt.hash}`,
      `签名: ${check.ok ? "有效" : `无效 (${check.reason})`}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    engine.close();
  }
}
