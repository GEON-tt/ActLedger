import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docFiles, findBrokenLinks, linkTargets } from "../../../scripts/check-docs-links.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

describe("docs links", () => {
  it("finds no broken links in the repository", () => {
    expect(findBrokenLinks(root)).toEqual([]);
  });

  it("reports a missing relative link and ignores the rest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actledger-docs-"));
    try {
      const readme = [
        "# T",
        "",
        "[a](docs/en/missing.md)",
        "[b](https://x.y)",
        "[c](#top)",
        "`[d](nope.md)`",
        "",
        "```",
        "[e](nope.md)",
        "```",
        "",
        "[f](docs/en/ok.md#sec)",
        "",
      ].join("\n");
      fs.mkdirSync(path.join(dir, "docs", "en"), { recursive: true });
      fs.writeFileSync(path.join(dir, "README.md"), readme);
      fs.writeFileSync(path.join(dir, "docs", "en", "ok.md"), "# Ok\n");
      expect(findBrokenLinks(dir)).toEqual([{ file: "README.md", line: 3, target: "docs/en/missing.md" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists the same pages in English and zh-CN", () => {
    const en = repoRelatives("docs/en/");
    const zh = repoRelatives("docs/zh-CN/");
    expect(en, "docs/en").toEqual(zh);
    expect(en, "docs/en").toHaveLength(16);
  });

  it("keeps heading levels and relative link counts in parity", () => {
    const pairs: Array<[string, string]> = [["README.md", "README.zh-CN.md"]];
    for (const rel of repoRelatives("docs/en/")) pairs.push([`docs/en/${rel}`, `docs/zh-CN/${rel}`]);
    for (const [enFile, zhFile] of pairs) {
      const enText = fs.readFileSync(path.join(root, enFile), "utf8");
      const zhText = fs.readFileSync(path.join(root, zhFile), "utf8");
      expect(headingLevels(zhText), `${enFile} headings`).toEqual(headingLevels(enText));
      expect(countableLinks(zhText), `${enFile} links`).toBe(countableLinks(enText));
    }
  });
});

function repoRelatives(prefix: string): string[] {
  return docFiles(root)
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .sort();
}

function headingLevels(markdown: string): number[] {
  const levels: number[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+/.exec(line);
    if (match?.[1]) levels.push(match[1].length);
  }
  return levels;
}

function countableLinks(markdown: string): number {
  return linkTargets(markdown).filter((link) => !link.target.startsWith("#") && !SCHEME.test(link.target)).length;
}
