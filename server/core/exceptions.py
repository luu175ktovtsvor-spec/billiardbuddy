import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


class AppException(Exception):
    """应用基础异常"""

    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code


class NotFoundException(AppException):
    def __init__(self, message: str = "资源不存在"):
        super().__init__(message, status_code=404)


class ValidationException(AppException):
    def __init__(self, message: str = "参数校验失败"):
        super().__init__(message, status_code=422)


class UnauthorizedException(AppException):
    def __init__(self, message: str = "未登录或登录已过期"):
        super().__init__(message, status_code=401)


class ForbiddenException(AppException):
    def __init__(self, message: str = "无权限访问"):
        super().__init__(message, status_code=403)


class AIServiceError(AppException):
    def __init__(self, message: str = "AI 生成服务暂时不可用"):
        super().__init__(message, status_code=500)


class AIProviderError(AppException):
    """AI 服务调用失败。

    面向用户的中文提示 + 原始异常（仅内部日志用）。
    """

    def __init__(
        self,
        message: str = "AI 生成服务暂时不可用",
        status_code: int = 502,
        provider_error: Exception | None = None,
    ):
        super().__init__(message, status_code=status_code)
        self.provider_error = provider_error


class QuotaExceededError(AppException):
    def __init__(self, message: str = "本月使用量已达上限"):
        super().__init__(message, status_code=429)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppException)
    async def app_exception_handler(request: Request, exc: AppException):
        if isinstance(exc, AIProviderError) and exc.provider_error:
            logger.error(
                "AIProviderError: %s | original: %s",
                exc.message,
                repr(exc.provider_error),
            )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.message},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.error("Unhandled exception", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "服务器内部错误"},
        )
