"""Agent Hook 机制（借鉴 cc-haha PreToolUse/PostToolUse）：执行前可拦截、执行后只观察、故障安全。"""
import asyncio

import pytest

from services.agent.hooks import (clear_hooks, register_post_tool_hook, register_pre_tool_hook)
from services.agent.loop import run_agent_loop
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


@pytest.fixture(autouse=True)
def _clean_hooks():
    clear_hooks()
    yield
    clear_hooks()  # 保证不泄漏到别的测试（hook 注册表是模块级）


def _tc(name, cid="c1"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": "{}"}}


def _reg(executed):
    reg = ToolRegistry()

    async def handler(args, ctx):
        executed.append("ran")
        return "工具结果X"

    reg.register(Tool(name="do_it", description="干活", parameters={"type": "object", "properties": {}}, handler=handler))
    return reg


def _provider():
    state = {"t": 0}

    class _P(MockTextProvider):
        async def generate(self, request):
            state["t"] += 1
            if state["t"] == 1:
                return TextResponse(content="", model="mock", tool_calls=[_tc("do_it")], finish_reason="tool_calls")
            return TextResponse(content="完成", model="mock", finish_reason="stop")

    return _P()


def test_pre_hook_can_block_tool():
    executed = []

    async def deny_hook(name, args, ctx):
        return {"deny": "敏感操作，先别"}

    register_pre_tool_hook(deny_hook)
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(executed), provider=_provider()))
    assert executed == []  # 被拦截，工具没执行
    assert any(s.type == "tool_result" and "已被拦截" in s.content for s in res.steps)


def test_post_hook_observes_result():
    seen = {}

    async def post_hook(name, args, result, ctx):
        seen["name"] = name
        seen["result"] = result

    register_post_tool_hook(post_hook)
    asyncio.run(run_agent_loop(user_message="x", registry=_reg([]), provider=_provider()))
    assert seen.get("name") == "do_it"
    assert seen.get("result") == "工具结果X"  # PostToolUse 看到的是执行后结果


def test_hook_failure_is_safe():
    executed = []

    async def bad_pre(name, args, ctx):
        raise RuntimeError("pre hook 炸了")

    async def bad_post(name, args, result, ctx):
        raise RuntimeError("post hook 炸了")

    register_pre_tool_hook(bad_pre)
    register_post_tool_hook(bad_post)
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(executed), provider=_provider()))
    # hook 抛异常不影响工具执行 + 循环
    assert executed == ["ran"]
    assert res.final_text == "完成"
    assert any(s.type == "tool_result" and s.content == "工具结果X" for s in res.steps)


def test_no_hooks_no_behavior_change():
    executed = []
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(executed), provider=_provider()))
    assert executed == ["ran"]
    assert res.final_text == "完成"
