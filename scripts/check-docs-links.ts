import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BrokenLink {
  file: string; // repo-relative, forward slashes
  line: number; // 1-based
  target: string; // as written
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function docFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of ["README.md", "README.zh-CN.md"]) {
    if (fs.existsSync(path.join(root, name))) out.push(name);
  }
  const docsDir = path.join(root, "docs");
  if (fs.existsSync(docsDir)) collectMarkdown(docsDir, "docs", out);
  out.sort();
  return out;
}

function collectMarkdown(dir: string, rel: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) collectMarkdown(path.join(dir, entry.name), childRel, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(childRel);
  }
}

export function linkTargets(markdown: string): Array<{ line: number; target: string }> {
  const out: Array<{ line: number; target: string }> = [];
  let inFence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const stripped = line.replace(/`[^`]*`/g, "");
    const linkRe = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(stripped)) !== null) {
      const target = match[1];
      if (target !== undefined) out.push({ line: i + 1, target });
    }
  }
  return out;
}

export function findBrokenLinks(root: string): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of docFiles(root)) {
    const markdown = fs.readFileSync(path.join(root, file), "utf8");
    for (const link of linkTargets(markdown)) {
      if (link.target.startsWith("#") || SCHEME.test(link.target)) continue;
      const bare = stripHashAndQuery(link.target);
      let decoded: string;
      try {
        decoded = decodeURIComponent(bare);
      } catch {
        broken.push({ file, line: link.line, target: link.target });
        continue;
      }
      const abs = decoded.startsWith("/")
        ? path.resolve(root, decoded.replace(/^\/+/, ""))
        : path.resolve(root, path.dirname(file), decoded);
      if (!fs.existsSync(abs)) broken.push({ file, line: link.line, target: link.target });
    }
  }
  return broken;
}

function stripHashAndQuery(target: string): string {
  const hash = target.indexOf("#");
  const query = target.indexOf("?");
  let cut = target.length;
  if (hash >= 0) cut = Math.min(cut, hash);
  if (query >= 0) cut = Math.min(cut, query);
  return target.slice(0, cut);
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const broken = findBrokenLinks(root);
  if (broken.length > 0) {
    for (const item of broken) process.stderr.write(`${item.file}:${item.line}: ${item.target}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok: ${docFiles(root).length} files\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
