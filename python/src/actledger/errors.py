from __future__ import annotations


class LedgerError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status: int = 400,
        details: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.details = details if details is not None else {}


class ApprovalRejected(Exception):
    def __init__(self, task: object) -> None:
        task_id = getattr(task, "id", "")
        super().__init__(f"task {task_id} was rejected")
        self.task = task


class ApprovalExpired(Exception):
    def __init__(self, task: object | None, message: str | None = None) -> None:
        if message is None:
            task_id = getattr(task, "id", "") if task is not None else ""
            message = f"task {task_id} expired"
        super().__init__(message)
        self.task = task


class ApprovalRevoked(Exception):
    def __init__(self, task: object) -> None:
        task_id = getattr(task, "id", "")
        super().__init__(f"task {task_id} was revoked")
        self.task = task


class ContentMismatch(Exception):
    def __init__(self, message: str = "executed payload does not match the approved payload") -> None:
        super().__init__(message)


class LedgerUnavailable(Exception):
    def __init__(self, message: str = "ledger unavailable") -> None:
        super().__init__(message)
