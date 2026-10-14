import type { TaskHandle } from "./ledger.js";

export class ApprovalRejected extends Error {
  readonly task: TaskHandle;
  constructor(task: TaskHandle) {
    super(`task ${task.id} was rejected`);
    this.name = "ApprovalRejected";
    this.task = task;
  }
}

export class ApprovalExpired extends Error {
  readonly task: TaskHandle | null;
  constructor(task: TaskHandle | null, message = `task ${task?.id ?? ""} expired`) {
    super(message);
    this.name = "ApprovalExpired";
    this.task = task;
  }
}

export class ApprovalRevoked extends Error {
  readonly task: TaskHandle;
  constructor(task: TaskHandle) {
    super(`task ${task.id} was revoked`);
    this.name = "ApprovalRevoked";
    this.task = task;
  }
}

export class ContentMismatch extends Error {
  constructor(message = "executed payload does not match the approved payload") {
    super(message);
    this.name = "ContentMismatch";
  }
}

export class LedgerUnavailable extends Error {
  constructor(message = "ledger unavailable") {
    super(message);
    this.name = "LedgerUnavailable";
  }
}
