"""计划模式(plan)测试：只读工具放行去探索，会动手的工具一律跳过不执行（对标 Claude Code plan mode）。"""
import asyncio

from services.agent.loop import _plan_tool_call
from services.agent.context import AgentContext
from services.agent.registry import ToolRegistry, Tool


def _reg() -> ToolRegistry:
    reg = ToolRegistry()

    async def w(args, ctx):
        return "wrote"

    async def r(args, ctx):
        return "read"

    reg.register(Tool(name="do_write", description="写", parameters={"type": "object", "properties": {}}, handler=w, read_only=False))
    reg.register(Tool(name="do_read", description="读", parameters={"type": "object", "properties": {}}, handler=r, read_only=True))
    return reg


def _tc(name: str) -> dict:
    return {"id": "1", "function": {"name": name, "arguments": "{}"}}


def test_plan_mode_skips_write_tool():
    plan = asyncio.run(_plan_tool_call(_tc("do_write"), _reg(), AgentContext(permission_mode="plan")))
    assert plan.fallback is True
    assert "计划模式" in (plan.fallback_msg or "")


def test_plan_mode_allows_read_only_tool():
    plan = asyncio.run(_plan_tool_call(_tc("do_read"), _reg(), AgentContext(permission_mode="plan")))
    assert not plan.fallback
    assert not plan.needs_approval


def test_non_plan_mode_does_not_skip_write():
    plan = asyncio.run(_plan_tool_call(_tc("do_write"), _reg(), AgentContext(permission_mode="ask")))
    assert not plan.fallback
