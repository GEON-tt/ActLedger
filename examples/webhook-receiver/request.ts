import { Ledger } from "@actledger/sdk";

const dir = process.argv[2] ?? process.env.ACTLEDGER_DIR;
if (!dir) {
  process.stderr.write("usage: tsx examples/webhook-receiver/request.ts <ledger dir>\n");
  process.exit(1);
}
const ledger = new Ledger({ mode: "local", dir });
const task = await ledger.request({
  principalId: "u_1",
  action: { type: "email.send" },
  payload: { action: "email.send", args: { to: "bob@example.com", body: "hello" } },
  intent: "send a test email",
});
process.stdout.write(`${task.id} ${task.state}\n`);
ledger.close();
