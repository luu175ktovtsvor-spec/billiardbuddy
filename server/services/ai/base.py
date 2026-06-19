from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class TextRequest:
    prompt: str = ""  # 单轮模式用；多轮/Agent 走 messages 时可留空（provider 优先用 messages）
    system_prompt: str | None = None
    messages: list[dict] | None = None  # 多轮对话消息数组
    max_tokens: int = 2000
    temperature: float = 0.7
    thinking: dict | None = None  # DeepSeek思考模式控制，如 {"type": "disabled"} 或 {"type": "enabled"}
    tools: list[dict] | None = None  # function calling 工具定义（OpenAI 格式：[{"type":"function","function":{...}}]）
    tool_choice: str | dict | None = None  # "auto" / "none" / "required" / {"type":"function","function":{"name":...}}
    model: str | None = None  # 本次调用模型覆写（编排大脑可用比生成更强的模型）；留空用 settings.text_model_name


@dataclass
class TextResponse:
    content: str
    model: str
    tokens_used: int = 0
    tool_calls: list[dict] | None = None  # 模型要调用的工具，标准化为 provider 无关 dict，可回灌进 messages
    finish_reason: str | None = None  # stop / tool_calls / length / content_filter / ...


class TextProvider(ABC):
    """文本模型抽象基类"""

    @abstractmethod
    async def generate(self, request: TextRequest) -> TextResponse:
        """一次性生成完整文本"""
        ...

    @abstractmethod
    async def generate_stream(
        self, request: TextRequest, usage_sink: dict | None = None,
        tool_calls_sink: list[dict] | None = None,
        finish_sink: dict | None = None,
    ) -> AsyncIterator[str]:
        """流式生成，逐块 yield 文本片段。

        tool_calls_sink: 可选列表。若本轮模型返回工具调用，流结束后把累积好的
        tool_calls（标准化 dict）写入其中，供 Agent 循环消费。

        usage_sink: 可选字典。生成结束后会把本次 token 用量
        （prompt_tokens / completion_tokens / total_tokens 等）写入其中。
        每次请求传入独立的 dict，避免并发请求间用量串号。

        finish_sink: 可选字典（SH-4）。流结束后把本轮 finish_reason 写入
        `finish_sink["finish_reason"]`（stop / tool_calls / length / ...）。Agent 循环据此识别
        被 max_tokens 截断（="length"）的最终答复并续写拼接。每次请求传入独立 dict，避免并发串号。
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
