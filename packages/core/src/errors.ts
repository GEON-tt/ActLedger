export class LedgerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof LedgerError;
}
