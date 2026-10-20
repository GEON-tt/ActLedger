import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EN } from "../src/serve/i18n";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const ALLOWED = new Map([["packages/cli/src/serve/html.ts", ["中文"]]]);

function files(dir: string, ext: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(ext)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

describe("published sources", () => {
  it("contain no CJK outside the zh-CN dictionary and the language switch", () => {
    const hits: string[] = [];
    const sources = [
      ...fs.readdirSync(path.join(root, "packages")).flatMap((pkg) => files(path.join(root, "packages", pkg, "src"), ".ts")),
      ...files(path.join(root, "python/src"), ".py"),
    ];
    for (const file of sources) {
      const rel = path.relative(root, file);
      if (rel === "packages/cli/src/serve/i18n.ts") continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        let rest = line;
        for (const word of ALLOWED.get(rel) ?? []) rest = rest.replaceAll(word, "");
        if (CJK.test(rest)) hits.push(`${rel}:${index + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("keeps the English console dictionary free of CJK", () => {
    expect(Object.entries(EN).filter(([, value]) => CJK.test(value)).map(([key]) => key)).toEqual([]);
  });
});
