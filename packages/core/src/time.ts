import { LedgerError } from "./errors.js";

export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function parseTimestamp(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LedgerError("invalid_request", `invalid timestamp ${value}`, 400);
  }
  return date;
}

const DURATION_MULT: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(input: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new LedgerError("policy_invalid", `invalid duration: ${input}`, 422);
  }
  return Number(match[1]) * DURATION_MULT[match[2]];
}

export function hourInTimeZone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
    const raw = Number(parts.find((part) => part.type === "hour")?.value ?? "NaN");
    if (!Number.isInteger(raw)) throw new Error("bad hour");
    return raw === 24 ? 0 : raw;
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("policy_invalid", `invalid timezone: ${timeZone}`, 422);
  }
}
