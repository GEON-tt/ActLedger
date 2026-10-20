import { createRequire } from "node:module";

export function renderQr(text: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const qrcode = require("qrcode-terminal") as {
      generate(text: string, opts: { small: boolean }, cb: (out: string) => void): void;
    };
    let out: string | null = null;
    qrcode.generate(text, { small: true }, (value) => {
      out = value;
    });
    return out;
  } catch {
    return null;
  }
}
