import { Ledger, type Payload } from "@actledger/sdk";

export interface SendReplyInput {
  userId: string;
  messageId: string;
  to: string[];
  subject: string;
  body: string;
}

export async function sendReply(ledger: Ledger, input: SendReplyInput, opts?: { timeoutMs?: number }) {
  const domain = input.to[0]?.split("@")[1] ?? "";
  const payload: Payload = {
    action: "email.send",
    args: { to: input.to, subject: input.subject },
    content: { content_type: "text/plain", text: input.body },
  };
  const task = await ledger.request({
    principalId: input.userId,
    agentId: "mail-agent",
    action: { type: "email.send", attrs: { recipient_domain: domain } },
    payload,
    intent: `回复邮件：${input.subject}`,
    idempotencyKey: `reply-${input.messageId}`,
  });
  const done = await task.wait({ timeoutMs: opts?.timeoutMs ?? 15_000, pollMs: 30 });
  if (done.state !== "approved") return { status: "not_sent" as const, state: done.state };
  const run = await done.claim();
  const msgId = `<${input.messageId}@example.test>`;
  const receipt = await run.complete({
    executedPayload: run.approvedPayload,
    externalProofs: [{ type: "email_msgid", value: msgId }],
  });
  return { status: "sent" as const, receiptId: receipt.id, messageId: msgId };
}
