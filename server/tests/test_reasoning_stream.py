"""F.1 思考过程流式：provider yield ReasoningChunk → loop 吐 reasoning 事件给前端展示，
且【思考绝不混进正文/历史】（避免 mimo 多轮+工具的 reasoning 回灌 400）。"""
import asyncio

from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop_stream, run_agent_loop
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import ReasoningChunk, TextResponse
from services.ai.providers.mock import MockTextProvider


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


async def _collect(agen):
    return [ev async for ev in agen]


class _ThinkingProvider(MockTextProvider):
    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        yield ReasoningChunk("我先想想这个台球房的情况…")
        yield "这是"
        yield "最终答复"
        if finish_sink is not None:
            finish_sink["finish_reason"] = "stop"


def test_stream_emits_reasoning_separate_from_content():
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="x", registry=_reg(), provider=_ThinkingProvider(), ctx=AgentContext(),
        system_prompt="sys", history=[], max_turns=3)))
    reasoning = [e for e in events if e["type"] == "reasoning"]
    tokens = [e for e in events if e["type"] == "token"]
    final = [e for e in events if e["type"] == "final"][0]
    assert any("我先想想" in e["content"] for e in reasoning)       # 思考被单独吐成 reasoning 事件
    assert final["content"] == "这是最终答复"                        # 正文不含思考
    assert all("我先想想" not in e["content"] for e in tokens)       # token 流不含思考


def test_sync_loop_unaffected_by_reasoning_type():
    """同步入口用 generate（不产 ReasoningChunk），照常返回、不崩。"""
    provider = MockTextProvider(scripted=[TextResponse(content="同步答复", model="mock", finish_reason="stop")])
    res = asyncio.run(run_agent_loop(
        user_message="x", registry=_reg(), provider=provider, ctx=AgentContext(),
        system_prompt="sys", history=[], max_turns=3))
    assert res.final_text == "同步答复"
