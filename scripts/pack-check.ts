import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
let tempDir = "";

const packages = [
  { dir: "core", tarball: "actledger-core-0.1.0.tgz" },
  { dir: "sdk", tarball: "actledger-sdk-0.1.0.tgz" },
  { dir: "cli", tarball: "actledger-cli-0.1.0.tgz" },
  { dir: "mcp-proxy", tarball: "actledger-mcp-proxy-0.1.0.tgz" },
] as const;

function step(name: string): void {
  process.stdout.write(`[pack-check] ${name}\n`);
}

function fail(message: string, result?: SpawnSyncReturns<string>): never {
  if (result) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (tempDir) process.stderr.write(`[pack-check] temp dir ${tempDir}\n`);
  process.stderr.write(`[pack-check] ${message}\n`);
  process.exit(1);
}

function run(cmd: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) fail(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(" ")} exited ${result.status ?? "null"}`, result);
  }
  return result;
}

function tarList(tgz: string): string[] {
  const result = run("tar", ["-tzf", tgz], root);
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function tarFile(tgz: string, member: string): string {
  const result = run("tar", ["-xzf", tgz, "-O", member], root);
  return result.stdout ?? "";
}

function forbidden(entry: string): boolean {
  const name = entry.replace(/^\.\//, "");
  if (name === "package/src" || name.startsWith("package/src/")) return true;
  if (name === "package/test" || name.startsWith("package/test/")) return true;
  const parts = name.split("/");
  if (parts.some((part) => part === ".actledger" || part === ".env" || part.startsWith(".env."))) return true;
  const base = parts[parts.length - 1] ?? name;
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return true;
  if (base.endsWith(".db")) return true;
  return false;
}

function referencedPaths(pkg: {
  exports?: unknown;
  bin?: string | Record<string, string>;
}): string[] {
  const paths: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      paths.push(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) walk(child);
  };
  walk(pkg.exports);
  if (typeof pkg.bin === "string") paths.push(pkg.bin);
  else if (pkg.bin) {
    for (const target of Object.values(pkg.bin)) paths.push(target);
  }
  return paths;
}

function toTarPath(spec: string): string {
  const relative = spec.replace(/^\.\//, "");
  return `package/${relative}`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actl-pack-"));
tempDir = tmp;
const tarballs = path.join(tmp, "tarballs");
const app = path.join(tmp, "app");
fs.mkdirSync(tarballs);

try {
  step("构建");
  run("pnpm", ["run", "build"], root);

  step("打包");
  for (const pkg of packages) {
    run("pnpm", ["pack", "--pack-destination", tarballs], path.join(root, "packages", pkg.dir));
    if (!fs.existsSync(path.join(tarballs, pkg.tarball))) {
      fail(`missing tarball ${pkg.tarball}; found ${fs.readdirSync(tarballs).join(", ")}`);
    }
  }

  step("检查 tarball");
  const required: Record<string, string[]> = {
    core: [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.js",
      "package/dist/index.d.ts",
    ],
    sdk: [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.js",
      "package/dist/index.d.ts",
    ],
    cli: ["package/package.json", "package/LICENSE", "package/README.md", "package/dist/main.js"],
    "mcp-proxy": [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/main.js",
    ],
  };
  for (const pkg of packages) {
    const tgz = path.join(tarballs, pkg.tarball);
    const entries = tarList(tgz);
    const entrySet = new Set(entries);
    for (const name of required[pkg.dir]) {
      if (!entrySet.has(name)) fail(`${pkg.tarball} missing ${name}`);
    }
    for (const entry of entries) {
      if (forbidden(entry)) fail(`${pkg.tarball} contains ${entry}`);
    }
    const raw = tarFile(tgz, "package/package.json");
    if (raw.includes("workspace:")) fail(`${pkg.tarball} package.json still contains workspace:`);
    const manifest = JSON.parse(raw) as {
      private?: unknown;
      dependencies?: Record<string, string>;
      exports?: unknown;
      bin?: string | Record<string, string>;
    };
    if ("private" in manifest) fail(`${pkg.tarball} package.json has private`);
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@actledger/") && version !== "0.1.0") {
        fail(`${pkg.tarball} dependency ${name} is ${version}, expected 0.1.0`);
      }
    }
    for (const spec of referencedPaths(manifest)) {
      const member = toTarPath(spec);
      if (!entrySet.has(member)) fail(`${pkg.tarball} ${spec} is not in the tarball`);
    }
  }

  step("安装");
  fs.mkdirSync(app);
  fs.writeFileSync(
    path.join(app, "package.json"),
    `${JSON.stringify(
      {
        name: "actl-pack-check",
        private: true,
        type: "module",
        dependencies: {
          "@actledger/core": "file:../tarballs/actledger-core-0.1.0.tgz",
          "@actledger/sdk": "file:../tarballs/actledger-sdk-0.1.0.tgz",
          "@actledger/cli": "file:../tarballs/actledger-cli-0.1.0.tgz",
          "@actledger/mcp-proxy": "file:../tarballs/actledger-mcp-proxy-0.1.0.tgz",
        },
        overrides: {
          "@actledger/core": "$@actledger/core",
          "@actledger/sdk": "$@actledger/sdk",
        },
      },
      null,
      2,
    )}\n`,
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], app);

  step("CLI help");
  const help = run(path.join(app, "node_modules/.bin/actledger"), ["--help"], app);
  const helpText = help.stdout ?? "";
  if (!helpText.includes("actledger init") || !helpText.includes("actledger verify")) {
    fail("actledger --help is missing init or verify", help);
  }

  step("CLI init");
  run(path.join(app, "node_modules/.bin/actledger"), ["init", "--dir", ".actledger"], app);
  for (const name of ["keys.json", "ledger.db", "policy.yaml", "app.json"]) {
    const file = path.join(app, ".actledger", name);
    if (!fs.existsSync(file)) fail(`init did not create .actledger/${name}`);
  }

  step("SDK 冒烟");
  const smoke = `import { Ledger } from "@actledger/sdk";
import { verifyWebhook } from "@actledger/sdk/webhook";
import { jcs, verifyJsonl } from "@actledger/core";
import { createProxy } from "@actledger/mcp-proxy";
for (const [n, f] of Object.entries({ verifyWebhook, jcs, verifyJsonl, createProxy })) {
  if (typeof f !== "function") throw new Error(\`\${n} missing\`);
}
const ledger = new Ledger({ mode: "local", dir: ".actledger" });
const task = await ledger.request({
  principalId: "u_1",
  action: { type: "email.read" },
  payload: { action: "email.read", args: { folder: "inbox" } },
  intent: "pack check",
});
const ready = await task.wait({ timeoutMs: 5_000 });
if (ready.state !== "approved") throw new Error(\`unexpected state \${ready.state}\`);
const run = await ready.claim();
await run.complete({ executedPayload: run.approvedPayload });
ledger.close();
`;
  fs.writeFileSync(path.join(app, "smoke.mjs"), smoke);
  run("node", ["smoke.mjs"], app);

  step("CLI export");
  const exported = run(path.join(app, "node_modules/.bin/actledger"), ["export", "--dir", ".actledger"], app);
  const receiptsPath = path.join(app, "receipts.jsonl");
  fs.writeFileSync(receiptsPath, exported.stdout ?? "");
  if (!fs.statSync(receiptsPath).size) fail("export produced an empty receipts.jsonl");

  step("CLI verify 自产回执");
  run(
    path.join(app, "node_modules/.bin/actledger"),
    ["verify", "receipts.jsonl", "--keys", ".actledger/keys.json"],
    app,
  );

  step("CLI verify 规范向量");
  const actledger = path.join(app, "node_modules/.bin/actledger");
  run(
    actledger,
    [
      "verify",
      path.join(root, "spec/test-vectors/receipts-chain-0.2.jsonl"),
      "--keys",
      path.join(root, "spec/test-vectors/keys.json"),
      "--secrets",
      path.join(root, "spec/test-vectors/secrets-0.2.jsonl"),
    ],
    app,
  );
  run(
    actledger,
    [
      "verify",
      path.join(root, "spec/test-vectors/receipts-chain-0.1.jsonl"),
      "--keys",
      path.join(root, "spec/test-vectors/keys.json"),
    ],
    app,
  );

  step("代理 help");
  const proxyHelp = run(path.join(app, "node_modules/.bin/actledger-mcp-proxy"), ["--help"], app);
  const proxyText = proxyHelp.stdout ?? "";
  if (!proxyText.includes("--upstream") || !proxyText.includes("--ledger")) {
    fail("actledger-mcp-proxy --help is missing --upstream or --ledger", proxyHelp);
  }

  step("消费方类型检查");
  fs.writeFileSync(
    path.join(app, "smoke.ts"),
    `import type { Receipt, TaskView } from "@actledger/sdk";\n${smoke}`,
  );
  fs.writeFileSync(
    path.join(app, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [path.join(root, "node_modules/@types")],
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run("node", [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(app, "tsconfig.json")], app);

  step("CLI rpc");
  const rpc = spawnSync(
    actledger,
    ["rpc", "--dir", ".actledger"],
    {
      cwd: app,
      encoding: "utf8",
      input: '{"id":1,"method":"hello","params":{}}\n{"id":2,"method":"shutdown","params":{}}\n',
    },
  );
  if (rpc.status !== 0) fail(`rpc exited ${rpc.status ?? "null"}`, rpc);
  const rpcLines = (rpc.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const helloLine = JSON.parse(rpcLines[0] ?? "{}") as { ok?: boolean; result?: { protocol?: string } };
  if (!helloLine.ok || helloLine.result?.protocol !== "actledger.rpc/1") {
    fail(`rpc hello failed: ${rpc.stdout ?? ""}`, rpc);
  }

  step("清理");
  if (keep) process.stdout.write(`[pack-check] kept ${tmp}\n`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write("pack-check ok\n");
} catch (error) {
  process.stderr.write(`[pack-check] temp dir ${tmp}\n`);
  throw error;
}
