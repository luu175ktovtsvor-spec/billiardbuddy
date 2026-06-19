import logging
from typing import AsyncIterator

from services.ai.base import TextProvider, TextRequest, TextResponse

logger = logging.getLogger(__name__)


class MockTextProvider(TextProvider):
    """Mock Provider — 返回固定文本，用于开发调试链路验证。

    可选 scripted：按顺序返回预设的 TextResponse（供 Agent 循环等多轮测试驱动），
    用尽后返回终止性答复，避免测试死循环。工厂以无参实例化 → scripted=None → 行为不变。
    """

    def __init__(self, scripted: list[TextResponse] | None = None):
        self._scripted = list(scripted) if scripted is not None else None

    async def generate(self, request: TextRequest) -> TextResponse:
        if self._scripted is not None:
            if not self._scripted:
                return TextResponse(content="[MOCK] 脚本已用尽", model="mock", tokens_used=0)
            return self._scripted.pop(0)
        logger.warning("正在使用 MockTextProvider，仅用于开发调试")
        return TextResponse(
            content=f"[MOCK] [Mock 生成结果]\n\nPrompt 长度: {len(request.prompt)} 字符\n\n这是开发环境 Mock 返回的文案内容，用于验证整条调用链路。",
            model="mock",
            tokens_used=0,
        )

    async def generate_stream(
        self, request: TextRequest, usage_sink: dict | None = None,
        tool_calls_sink: list[dict] | None = None,
        finish_sink: dict | None = None,
    ) -> AsyncIterator[str]:
        if self._scripted is not None:
            resp = self._scripted.pop(0) if self._scripted else TextResponse(content="[MOCK] 脚本已用尽", model="mock")
            if resp.content:
                yield resp.content
            if resp.tool_calls and tool_calls_sink is not None:
                tool_calls_sink.extend(resp.tool_calls)
            if finish_sink is not None and resp.finish_reason is not None:
                finish_sink["finish_reason"] = resp.finish_reason  # SH-4：透出脚本的 finish_reason 供截断恢复测试
            if usage_sink is not None:
                # SH-2：透出脚本里的 tokens_used，供 token 预算早停测试驱动（脚本没设则 0）
                t = resp.tokens_used or 0
                usage_sink.update({"prompt_tokens": 0, "completion_tokens": t, "total_tokens": t})
            return
        logger.warning("正在使用 MockTextProvider（流式），仅用于开发调试")
        yield "[MOCK] [Mock 流式输出] "
        yield "这是开发环境 Mock 返回的流式内容。"
        if usage_sink is not None:
            usage_sink.update({
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            })
