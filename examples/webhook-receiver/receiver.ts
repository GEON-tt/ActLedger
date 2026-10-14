import http from "node:http";
import { verifyWebhook } from "@actledger/sdk/webhook";

export function createReceiver(
  secret: string,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): http.Server {
  const seen = new Set<string>();
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hook") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const header = req.headers["actledger-signature"];
      let event;
      try {
        event = verifyWebhook(Buffer.concat(chunks), typeof header === "string" ? header : "", secret);
      } catch (error) {
        res.writeHead(401).end();
        log(`rejected: ${(error as Error).message}`);
        return;
      }
      res.writeHead(204).end();
      if (seen.has(event.id)) return;
      seen.add(event.id);
      log(`${event.type} ${String(event.data.task_id)} state=${String(event.data.state)}`);
      if (typeof event.data.approve_url === "string") log(`approve_url: ${event.data.approve_url}`);
    });
  });
}
