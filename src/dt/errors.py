class DtError(Exception):
    """业务错误。code 给程序判断，hint 告诉 agent 下一步怎么改。"""

    def __init__(self, code: str, message: str, hint: str | None = None, *, status: int = 400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status
        self.details = details

    def to_dict(self) -> dict:
        err = {"code": self.code, "message": self.message, "hint": self.hint}
        if self.details is not None:
            err["details"] = self.details
        return err


def not_found(what: str, hint: str | None = None) -> DtError:
    return DtError("not_found", f"{what} 不存在", hint, status=404)
