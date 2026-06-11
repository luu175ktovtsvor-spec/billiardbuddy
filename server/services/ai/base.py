from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class TextRequest:
    prompt: str
    system_prompt: str | None = None
    messages: list[dict] | None = None  # 多轮对话消息数组
    max_tokens: int = 2000
    temperature: float = 0.7
    thinking: dict | None = None  # DeepSeek思考模式控制，如 {"type": "disabled"} 或 {"type": "enabled"}


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
    async def generate_stream(
        self, request: TextRequest, usage_sink: dict | None = None
    ) -> AsyncIterator[str]:
        """流式生成，逐块 yield 文本片段。

        usage_sink: 可选字典。生成结束后会把本次 token 用量
        （prompt_tokens / completion_tokens / total_tokens 等）写入其中。
        每次请求传入独立的 dict，避免并发请求间用量串号。
        """
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
        quality: str = "auto",
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        """生成图片，返回 PNG bytes。

        Parameters
        ----------
        image : bytes | list[bytes] | None
            参考图片 bytes。传入后模型会直接读取图片内容生成。
        quality : str
            图片质量：low(草稿) / medium(标准) / high(高清) / auto(自动)
        """
        ...
