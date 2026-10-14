import { Ledger } from "@actledger/sdk";
import { sendReply } from "./agent";

const dir = process.env.ACTLEDGER_DIR ?? ".actledger";
const ledger = new Ledger({ mode: "local", dir });
const result = await sendReply(ledger, {
  userId: process.argv[2] ?? "u_1",
  messageId: process.argv[3] ?? `m_${Date.now()}`,
  to: [process.argv[4] ?? "bob@clienta.com"],
  subject: process.argv[5] ?? "Re: 报价",
  body: process.argv[6] ?? "Bob 你好",
});
process.stdout.write(`${JSON.stringify(result)}\n`);
ledger.close();
