import fs from "node:fs";
import path from "node:path";
import { LedgerError } from "@actledger/core";
import { startServer } from "../serve/server.js";
import { defaultTokenFile, loadOrCreateLoginToken, loginUrl, rotateLoginToken } from "../serve/token.js";

export async function serveCommand(opts: {
  dir: string;
  port: number;
  approver?: string;
  tokenFile?: string;
  printLogin: boolean;
  rotateToken: boolean;
  oneTimeLogin: boolean;
}): Promise<void> {
  if (opts.printLogin) {
    const dir = path.resolve(opts.dir);
    if (!fs.existsSync(path.join(dir, "app.json"))) {
      throw new LedgerError("not_found", `${dir} is not an actledger directory; run actledger init`, 404);
    }
    const file = opts.tokenFile ? path.resolve(process.cwd(), opts.tokenFile) : defaultTokenFile(dir);
    const log = (line: string) => process.stderr.write(`${line}\n`);
    const now = () => new Date();
    const record = opts.rotateToken ? rotateLoginToken(file, { now, log }) : loadOrCreateLoginToken(file, { now, log });
    process.stdout.write(`${loginUrl(`http://127.0.0.1:${opts.port}`, record.token)}\n`);
    return;
  }

  const handle = await startServer({
    dir: opts.dir,
    port: opts.port,
    approver: opts.approver,
    loginMode: opts.oneTimeLogin ? "one-time" : "persistent",
    tokenFile: opts.tokenFile ? path.resolve(process.cwd(), opts.tokenFile) : undefined,
    rotateToken: opts.rotateToken,
  });
  process.stdout.write(`actledger serve ${handle.origin}\n`);
  const label = handle.loginMode === "one-time" ? "login (one-time)" : "login";
  process.stdout.write(`${label}: ${handle.loginUrl}\n`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
