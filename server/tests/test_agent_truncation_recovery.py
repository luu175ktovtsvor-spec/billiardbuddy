"""SH-4 · max_output_tokens 截断恢复（续写拼接）。

锁住：
- finish_reason="stop" 正常收尾，不触发续写
- finish_reason="length" → 把已输出 append + 续写提示，再要一轮，多轮片段拼成完整 final
- 连续截断到上限强制收尾，不死循环
- 同步 run_agent_loop 与流式 run_agent_loop_stream 两入口都正确续写拼接
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.loop import run_agent_loop, run_agent_loop_stream, _MAX_CONTINUATIONS
from services.agent.registry import Tool, ToolRegistry


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


async def _collect(agen):
    return [ev async for ev in agen]


# ---------- 同步 ----------

def test_sync_no_recovery_on_stop():
    provider = MockTextProvider(scripted=[TextResponse(content="完整答复", model="mock", finish_reason="stop")])
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(), provider=provider))
    assert res.final_text == "完整答复"
    assert res.turns == 1  # 没续写


def test_sync_length_triggers_continuation_and_concat():
    provider = MockTextProvider(scripted=[
        TextResponse(content="前半段", model="mock", finish_reason="length"),
        TextResponse(content="后半段", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="写长文", registry=_reg(), provider=provider))
    assert res.final_text == "前半段后半段"  # 两段拼接
    assert res.turns == 2


def test_sync_multi_length_concat():
    provider = MockTextProvider(scripted=[
        TextResponse(content="A", model="mock", finish_reason="length"),
        TextResponse(content="B", model="mock", finish_reason="length"),
        TextResponse(content="C", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(), provider=provider))
    assert res.final_text == "ABC"


def test_sync_continuation_capped_no_infinite_loop():
    """永远 length → 续写到上限后强制收尾，不死循环。"""
    class _AlwaysLength(MockTextProvider):
        async def generate(self, request):
            return TextResponse(content="片", model="mock", finish_reason="length")

    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(),
                                     provider=_AlwaysLength(), max_turns=20))
    # 续写上限 _MAX_CONTINUATIONS 次后，再来一段当作最终（共 _MAX_CONTINUATIONS+1 段"片"）
    assert res.final_text == "片" * (_MAX_CONTINUATIONS + 1)
    assert res.stopped_reason == "final"
    assert res.turns <= _MAX_CONTINUATIONS + 1  # 没跑飞到 max_turns


# ---------- 流式 ----------

def test_stream_no_recovery_on_stop():
    provider = MockTextProvider(scripted=[TextResponse(content="完整答复", model="mock", finish_reason="stop")])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="x", registry=_reg(), provider=provider)))
    final = [e for e in events if e["type"] == "final"]
    assert final and final[0]["content"] == "完整答复"


def test_stream_length_triggers_continuation_and_concat():
    provider = MockTextProvider(scripted=[
        TextResponse(content="前半段", model="mock", finish_reason="length"),
        TextResponse(content="后半段", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="写长文", registry=_reg(), provider=provider)))
    # token 逐片吐出含两段
    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert tokens == "前半段后半段"
    # final 是拼接后的完整答复
    final = [e for e in events if e["type"] == "final"]
    assert final and final[0]["content"] == "前半段后半段"
    assert events[-1]["type"] == "done"


def test_stream_continuation_capped():
    class _AlwaysLength(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "片"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "length"

    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="x", registry=_reg(), provider=_AlwaysLength(), max_turns=20)))
    final = [e for e in events if e["type"] == "final"]
    assert final and final[0]["content"] == "片" * (_MAX_CONTINUATIONS + 1)
    assert events[-1]["stopped_reason"] == "final"
