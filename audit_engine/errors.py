from __future__ import annotations

import uuid


class EngineError(Exception):
    def __init__(self, code: str, user_message: str, *, retryable: bool = False, detail: str | None = None):
        super().__init__(user_message)
        self.code = code
        self.user_message = user_message
        self.retryable = retryable
        self.detail = detail
        self.diagnostic_id = uuid.uuid4().hex[:12]

    def as_dict(self) -> dict:
        result = {
            "code": self.code,
            "userMessage": self.user_message,
            "retryable": self.retryable,
            "diagnosticId": self.diagnostic_id,
        }
        if self.detail:
            result["detail"] = self.detail
        return result
