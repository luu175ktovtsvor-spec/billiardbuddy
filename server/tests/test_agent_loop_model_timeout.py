"""对话路径模型墙钟兜底:上游(网关/模型)迟迟不响应时,循环到点友好收尾,不无限挂住。

复现 owner 真机:网关抽风→文字模型首片迟迟不来→对话转 16 分钟不出确认卡。
这里用"首片前先睡很久"的假 provider + 把墙钟预算压到 0.2s,验证两条路都在预算内友好收尾。
"""
import asyncio
import time

import pytest

from services.ai.base import TextProvider, TextResponse
from services.agent import loop as loop_mod
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import ToolRegistry


class _HangingProvider(TextProvider):
    """首片/整包返回前睡很久,模拟网关连不上/读超时/重试打转。"""

    async def generate(self, request):
        await asyncio.sleep(30)
        return TextResponse(content="不该走到这", model="hang")

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        await asyncio.sleep(30)
        yield "不该走到这"


@pytest.fixture
def _tiny_budget(monkeypatch):
    monkeypatch.setattr(loop_mod, "_MODEL_CALL_BUDGET", 0.2)


@pytest.mark.asyncio
async def test_stream_loop_friendly_timeout_on_model_stall(_tiny_budget):
    reg = ToolRegistry()
    t0 = time.monotonic()
    events = []
    async for ev in run_agent_loop_stream(
        system_prompt="s", history=[], user_message="把这张图做成视频",
        registry=reg, provider=_HangingProvider(), model="hang",
    ):
        events.append(ev)
    elapsed = time.monotonic() - t0

    done = [e for e in events if e.get("type") == "done"]
    finals = [e for e in events if e.get("type") == "final"]
    assert done and done[-1]["stopped_reason"] == "timeout"
    assert finals and "没及时响应" in finals[-1]["content"]
    assert elapsed < 5, f"应在预算内迅速兜底,而不是干等,实际 {elapsed:.1f}s"


@pytest.mark.asyncio
async def test_sync_loop_friendly_timeout_on_model_stall(_tiny_budget):
    reg = ToolRegistry()
    t0 = time.monotonic()
    res = await run_agent_loop(
        system_prompt="s", history=[], user_message="把这张图做成视频",
        registry=reg, provider=_HangingProvider(), model="hang",
    )
    elapsed = time.monotonic() - t0

    assert res.stopped_reason == "timeout"
    assert "没及时响应" in res.final_text
    assert elapsed < 5, f"应在预算内迅速兜底,实际 {elapsed:.1f}s"
