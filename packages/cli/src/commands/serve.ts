import { startServer } from "../serve/server.js";

export async function serveCommand(opts: { dir: string; port: number; approver?: string }): Promise<void> {
  const handle = await startServer({ dir: opts.dir, port: opts.port, approver: opts.approver });
  process.stdout.write(`actledger serve ${handle.origin}\n`);
  process.stdout.write(`login (one-time): ${handle.loginUrl}\n`);
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
