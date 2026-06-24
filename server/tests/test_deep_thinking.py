"""F.2 深度思考 开/关：端点归一 → loop 透传 → provider 的 TextRequest.thinking。"""
import asyncio

from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.ai.providers.mock import MockTextProvider


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


def test_deep_thinking_normalization():
    from api.v1.agent import _deep_thinking_to_param
    assert _deep_thinking_to_param(True) == {"type": "enabled"}
    assert _deep_thinking_to_param(False) == {"type": "disabled"}
    assert _deep_thinking_to_param(None) is None


def test_thinking_flows_into_provider_request():
    captured = {}

    class _P(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            captured["thinking"] = request.thinking
            yield "答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"

    async def run():
        return [e async for e in run_agent_loop_stream(
            user_message="x", registry=_reg(), provider=_P(), ctx=AgentContext(),
            system_prompt="sys", history=[], max_turns=2, thinking={"type": "disabled"})]

    asyncio.run(run())
    assert captured["thinking"] == {"type": "disabled"}
