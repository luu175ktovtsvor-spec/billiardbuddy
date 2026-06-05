import logging
from typing import AsyncIterator

from services.ai.base import TextProvider, TextRequest, TextResponse

logger = logging.getLogger(__name__)


class MockTextProvider(TextProvider):
    """Mock Provider — 返回固定文本，用于开发调试链路验证"""

    async def generate(self, request: TextRequest) -> TextResponse:
        logger.warning("正在使用 MockTextProvider，仅用于开发调试")
        return TextResponse(
            content=f"[MOCK] [Mock 生成结果]\n\nPrompt 长度: {len(request.prompt)} 字符\n\n这是开发环境 Mock 返回的文案内容，用于验证整条调用链路。",
            model="mock",
            tokens_used=0,
        )

    async def generate_stream(self, request: TextRequest) -> AsyncIterator[str]:
        logger.warning("正在使用 MockTextProvider（流式），仅用于开发调试")
        yield "[MOCK] [Mock 流式输出] "
        yield "这是开发环境 Mock 返回的流式内容。"
