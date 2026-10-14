import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LedgerError } from "@actledger/core";
import { describe, expect, it } from "vitest";
import { loadProxyConfig, resolveConfig } from "../src/config";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "actl-cfg-"));
}

describe("config", () => {
  it("reads YAML and JSON and resolves paths from the config directory", () => {
    const dir = tempDir();
    const yaml = `
version: 1
name: mail
ledger: ./ledgers/demo
principal: ada
agent_id: mcp-proxy:mail
upstream:
  command: node
  args: ["server.js"]
  cwd: ./work
  env_passthrough: [MAIL_TOKEN]
approval:
  wait_ms: 1500
check_task_tool: check_mail
unmapped: hide
tools:
  send_email:
    action: email.send
    allowed_drift: ["args.subject"]
`;
    const yamlFile = path.join(dir, "proxy.config.yaml");
    fs.writeFileSync(yamlFile, yaml);
    const fromYaml = loadProxyConfig(yamlFile);
    expect(fromYaml.ledger).toBe(path.resolve(dir, "ledgers/demo"));
    expect(fromYaml.upstream?.cwd).toBe(path.resolve(dir, "work"));
    expect(fromYaml.upstream?.envPassthrough).toEqual(["MAIL_TOKEN"]);
    const resolved = resolveConfig({ help: false }, fromYaml);
    expect(resolved.ledger).toBe(path.resolve(dir, "ledgers/demo"));
    expect(resolved.agentId).toBe("mcp-proxy:mail");
    expect(resolved.approval.waitMs).toBe(1500);
    expect(resolved.checkTaskTool).toBe("check_mail");
    expect(resolved.unmapped).toBe("hide");
    expect(resolved.tools.send_email?.allowedDrift).toEqual(["args.subject"]);

    const jsonFile = path.join(dir, "proxy.config.json");
    fs.writeFileSync(
      jsonFile,
      JSON.stringify({
        version: 1,
        ledger: "nested/ledger",
        upstream: { command: "node", args: ["server.js"], cwd: "nested/work" },
      }),
    );
    const fromJson = loadProxyConfig(jsonFile);
    expect(fromJson.ledger).toBe(path.resolve(dir, "nested/ledger"));
    expect(fromJson.upstream?.cwd).toBe(path.resolve(dir, "nested/work"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects wait_ms outside 0..30000", () => {
    const dir = tempDir();
    const file = path.join(dir, "proxy.config.yaml");
    fs.writeFileSync(
      file,
      "version: 1\nledger: .\nupstream:\n  command: node\napproval:\n  wait_ms: 30001\n",
    );
    const loaded = loadProxyConfig(file);
    expect(() => resolveConfig({ help: false }, loaded)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an illegal allowed_drift path", () => {
    const dir = tempDir();
    const file = path.join(dir, "proxy.config.yaml");
    fs.writeFileSync(
      file,
      `
version: 1
ledger: .
upstream:
  command: node
tools:
  send_email:
    action: email.send
    allowed_drift: ["body"]
`,
    );
    const loaded = loadProxyConfig(file);
    expect(() => resolveConfig({ help: false }, loaded)).toThrow(LedgerError);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects attrs_from keys that overwrite mcp_server or mcp_tool", () => {
    const dir = tempDir();
    const file = path.join(dir, "proxy.config.yaml");
    fs.writeFileSync(
      file,
      `
version: 1
ledger: .
upstream:
  command: node
tools:
  send_email:
    action: email.send
    attrs_from:
      mcp_tool: to
      mcp_server: subject
`,
    );
    expect(() => loadProxyConfig(file)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => loadProxyConfig(file)).toThrow(/reserved key mcp_/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
