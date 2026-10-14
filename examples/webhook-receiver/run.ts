import { createReceiver } from "./receiver";

const secret = process.env.ACTLEDGER_WEBHOOK_SECRET;
if (!secret) {
  process.stderr.write("set ACTLEDGER_WEBHOOK_SECRET to the same value serve uses\n");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
createReceiver(secret).listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on http://127.0.0.1:${port}/hook\n`);
});
