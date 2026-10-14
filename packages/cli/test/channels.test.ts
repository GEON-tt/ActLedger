import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerError } from "@actledger/core";
import { CHANNELS_EXAMPLE, loadChannelsConfig } from "../src/serve/channels.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "packages/cli/src/main.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actl-channels-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(text: string): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "channels.yaml"), text);
  return dir;
}

const uncommented = `public_url: http://127.0.0.1:4319
channels:
  - name: team-webhook
    type: webhook
    url: https://example.com/actledger-hook
    secret_env: ACTLEDGER_WEBHOOK_SECRET
    events: [task.pending_approval, task.approved, task.rejected]
    include_payload: false
`;

describe("channels.yaml", () => {
  it("treats the commented example and a missing file as zero channels", () => {
    const example = writeConfig(CHANNELS_EXAMPLE);
    expect(loadChannelsConfig(example, { env: {} })).toEqual({ publicUrl: null, channels: [], skipped: [] });
    const missing = tempDir();
    expect(loadChannelsConfig(missing, { env: {} })).toEqual({ publicUrl: null, channels: [], skipped: [] });
  });

  it("loads the uncommented example when the secret is present", () => {
    const dir = writeConfig(uncommented);
    const config = loadChannelsConfig(dir, { env: { ACTLEDGER_WEBHOOK_SECRET: "sek" } });
    expect(config.publicUrl).toBe("http://127.0.0.1:4319");
    expect(config.skipped).toEqual([]);
    expect(config.channels).toEqual([
      {
        name: "team-webhook",
        type: "webhook",
        url: "https://example.com/actledger-hook",
        secretEnv: "ACTLEDGER_WEBHOOK_SECRET",
        events: ["task.pending_approval", "task.approved", "task.rejected"],
        includePayload: false,
      },
    ]);
  });

  it("rejects invalid channel files", () => {
    const cases = [
      `channels:\n  - name: team\n    type: webhook\n    url: https://example.com/hook\n    secret_env: sk_live_xxx\n`,
      `channels:\n  - name: team\n    type: slack\n    url: https://example.com/hook\n    secret_env: ACTLEDGER_WEBHOOK_SECRET\n`,
      `extra: true\n`,
      `channels:\n  - name: team\n    type: webhook\n    url: https://example.com/hook\n    secret_env: ACTLEDGER_WEBHOOK_SECRET\n    events: [task.executed]\n`,
      "channels: [\n",
    ];
    for (const text of cases) {
      const dir = writeConfig(text);
      expect(() => loadChannelsConfig(dir, { env: { ACTLEDGER_WEBHOOK_SECRET: "sek" } })).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
      try {
        loadChannelsConfig(dir, { env: { ACTLEDGER_WEBHOOK_SECRET: "sek" } });
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerError);
        expect((error as LedgerError).message).toContain("channels.yaml");
      }
    }
  });

  it("init writes the commented channels file and a private link key", () => {
    const dir = tempDir();
    const result = spawnSync(process.execPath, [tsx, cli, "init", "--dir", dir], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, "channels.yaml"), "utf8")).toBe(CHANNELS_EXAMPLE);
    const key = path.join(dir, "keys", "link-hmac.key");
    expect(fs.readFileSync(key)).toHaveLength(32);
    expect(fs.statSync(key).mode & 0o777).toBe(0o600);
  });
});
