import { LedgerError } from "@actledger/core";
import { describe, expect, it } from "vitest";
import { parseArgs, splitCommand } from "../src/args";

describe("args", () => {
  it("splits quotes and backslash escapes", () => {
    expect(splitCommand("node server.js --flag")).toEqual(["node", "server.js", "--flag"]);
    expect(splitCommand(`node "my server.js" 'a b'`)).toEqual(["node", "my server.js", "a b"]);
    expect(splitCommand(String.raw`node a\ b "c\"d"`)).toEqual(["node", "a b", 'c"d']);
    expect(splitCommand("node ''")).toEqual(["node", ""]);
  });

  it("rejects --upstream together with --", () => {
    expect(() => parseArgs(["--upstream", "node server.js", "--", "node", "other.js"])).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--ledger", ".actledger", "--nope"])).toThrow(LedgerError);
    expect(() => parseArgs(["--not-a-flag"])).toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });

  it("keeps the command after -- as argv", () => {
    const args = parseArgs(["--ledger", ".actledger", "--", "node", "server.js", "--flag"]);
    expect(args.ledger).toBe(".actledger");
    expect(args.command).toEqual(["node", "server.js", "--flag"]);
  });
});
