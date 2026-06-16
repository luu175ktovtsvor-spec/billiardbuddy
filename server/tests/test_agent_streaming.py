"""P0.5 DeepSeek 流式工具调用解析。

锁住（官方无 stream+tools 整合示例，自测兜住增量拼接这个最易错的点）：
- 流式 delta.tool_calls 按 index 累积：id/name 在首片、arguments 分片拼接
- tool_calls 经 tool_calls_sink 在流结束后回填给调用方
- 纯文本流不受影响：逐片 yield，tool_calls_sink 保持空
- tools 透传进 SDK 调用
- usage_sink 仍正常写入
"""
import asyncio
from types import SimpleNamespace

from services.ai.base import TextRequest
from services.ai.providers.deepseek import DeepSeekProvider

SAMPLE_TOOLS = [{"type": "function", "function": {"name": "get_today", "description": "d",
                                                  "parameters": {"type": "object", "properties": {}}}}]


def _dtc(index, call_id=None, name=None, args=None):
    """构造一个流式 delta.tool_calls 分片。"""
    return SimpleNamespace(
        index=index, id=call_id, type="function" if call_id else None,
        function=SimpleNamespace(name=name, arguments=args),
    )


def _chunk(content=None, tool_calls=None, usage=None):
    delta = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=usage)


class _FakeStreamCompletions:
    def __init__(self, chunks):
        self._chunks = chunks
        self.captured_kwargs = None

    async def create(self, **kwargs):
        self.captured_kwargs = kwargs
        chunks = self._chunks

        async def gen():
            for c in chunks:
                yield c

        return gen()


def _provider(chunks):
    p = DeepSeekProvider()
    fake = _FakeStreamCompletions(chunks)
    p._client = SimpleNamespace(chat=SimpleNamespace(completions=fake))
    return p, fake


def test_stream_accumulates_tool_calls():
    chunks = [
        _chunk(tool_calls=[_dtc(0, call_id="call_1", name="get_today", args='{"ci')]),
        _chunk(tool_calls=[_dtc(0, args='ty":"成都"}')]),
        _chunk(usage=SimpleNamespace(prompt_tokens=1, completion_tokens=2, total_tokens=3)),
    ]
    p, _ = _provider(chunks)
    sink: list = []

    async def run():
        return [t async for t in p.generate_stream(
            TextRequest(prompt="今天干啥", tools=SAMPLE_TOOLS), tool_calls_sink=sink)]

    out = asyncio.run(run())
    assert out == []  # 本轮只有工具调用、无文本
    assert sink == [{
        "id": "call_1", "type": "function",
        "function": {"name": "get_today", "arguments": '{"city":"成都"}'},
    }]


def test_stream_text_only_leaves_sink_empty():
    chunks = [_chunk(content="今天"), _chunk(content="适合搞活动")]
    p, _ = _provider(chunks)
    sink: list = []

    async def run():
        return [t async for t in p.generate_stream(TextRequest(prompt="x"), tool_calls_sink=sink)]

    out = asyncio.run(run())
    assert "".join(out) == "今天适合搞活动"
    assert sink == []


def test_stream_passes_tools_to_sdk():
    p, fake = _provider([_chunk(content="ok")])

    async def run():
        return [t async for t in p.generate_stream(TextRequest(prompt="x", tools=SAMPLE_TOOLS, tool_choice="auto"))]

    asyncio.run(run())
    assert fake.captured_kwargs["tools"] == SAMPLE_TOOLS
    assert fake.captured_kwargs["tool_choice"] == "auto"


def test_stream_usage_sink_still_works():
    chunks = [_chunk(content="hi"),
              _chunk(usage=SimpleNamespace(prompt_tokens=5, completion_tokens=7, total_tokens=12))]
    p, _ = _provider(chunks)
    usage: dict = {}

    async def run():
        return [t async for t in p.generate_stream(TextRequest(prompt="x"), usage_sink=usage)]

    asyncio.run(run())
    assert usage.get("total_tokens") == 12


def test_stream_multiple_tool_calls_by_index():
    """一轮并行多个工具调用：按 index 各自累积，不串号。"""
    chunks = [
        _chunk(tool_calls=[_dtc(0, call_id="a", name="f0", args='{}')]),
        _chunk(tool_calls=[_dtc(1, call_id="b", name="f1", args='{"k":1}')]),
    ]
    p, _ = _provider(chunks)
    sink: list = []

    async def run():
        return [t async for t in p.generate_stream(TextRequest(prompt="x", tools=SAMPLE_TOOLS), tool_calls_sink=sink)]

    asyncio.run(run())
    assert [tc["id"] for tc in sink] == ["a", "b"]
    assert sink[1]["function"]["name"] == "f1"
    assert sink[1]["function"]["arguments"] == '{"k":1}'
