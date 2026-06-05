from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class TextRequest:
    prompt: str
    system_prompt: str | None = None
    max_tokens: int = 2000
    temperature: float = 0.7


@dataclass
class TextResponse:
    content: str
    model: str
    tokens_used: int = 0


class TextProvider(ABC):
    """文本模型抽象基类"""

    @abstractmethod
    async def generate(self, request: TextRequest) -> TextResponse:
        """一次性生成完整文本"""
        ...

    @abstractmethod
    async def generate_stream(self, request: TextRequest) -> AsyncIterator[str]:
        """流式生成，逐块 yield 文本片段"""
        ...


class ImageProvider(ABC):
    """AI 图片生成 Provider 抽象基类。"""

    name: str = ""
    supported_models: list[str] = []

    @abstractmethod
    async def generate_image(
        self,
        prompt: str,
        model: str = "",
        size: str = "1024*1024",
        **kwargs,
    ) -> bytes:
        """生成图片，返回 PNG bytes。"""
        ...
