import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STATES, TRANSITIONS, canTransition, isTerminal, type State } from "../src/states";

describe("state machine", () => {
  it("matches spec/transitions.json", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../spec/transitions.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(TRANSITIONS);
  });

  it("rejects every transition that is not listed", () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const allowed = TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
      }
    }
  });

  it("treats executed, failed, rejected, drafted, expired and revoked as terminal", () => {
    for (const state of STATES) {
      const terminal = ["executed", "failed", "rejected", "drafted", "expired", "revoked"].includes(state);
      expect(isTerminal(state as State)).toBe(terminal);
      if (terminal) expect(TRANSITIONS[state]).toEqual([]);
    }
  });
});
