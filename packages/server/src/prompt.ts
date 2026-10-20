import { LedgerError } from "@actledger/core";

/** Read a line from the terminal without echoing. Requires a TTY. */
export function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new LedgerError("invalid_request", "cancelled", 400));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          buf = [...buf].slice(0, -1).join("");
          continue;
        }
        buf += char;
      }
    };
    stdin.on("data", onData);
  });
}
