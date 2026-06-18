"""工具入参 jsonschema 校验（借鉴 cc-haha 工具脊椎）：

- 缺必填参数 → 不执行工具，把"[入参校验失败]"回灌给模型让它改参数重试
- 入参合法 → 照常执行（无回归）
- 工具没声明 schema 约束 → 跳过校验、照常执行
- 校验先于审批闸：受审批工具入参非法时回灌校验错误、不弹 approval_request
"""
import asyncio

from services.agent.loop import run_agent_loop
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _run(**kw):
    return asyncio.run(run_agent_loop(**kw))


def _reg(handler, name, parameters, requires_approval=False, approval_class="spend"):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="测试工具", parameters=parameters, handler=handler,
                      requires_approval=requires_approval, approval_class=approval_class))
    return reg


_SCHEMA_REQ = {"type": "object", "properties": {"need": {"type": "string"}}, "required": ["need"]}


def test_missing_required_arg_fed_back_not_executed():
    calls = []

    async def handler(args, ctx):
        calls.append(args)
        return "已写"

    reg = _reg(handler, "writer", _SCHEMA_REQ)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("writer", "{}")], finish_reason="tool_calls"),
        TextResponse(content="好的我补上需求", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="写条朋友圈", registry=reg, provider=provider)

    assert calls == []  # 校验未过 → 工具绝不执行
    assert any(s.type == "tool_result" and "[入参校验失败]" in s.content for s in res.steps)
    assert res.final_text == "好的我补上需求"


def test_valid_args_execute_normally():
    calls = []

    async def handler(args, ctx):
        calls.append(args)
        return "已写"

    reg = _reg(handler, "writer", _SCHEMA_REQ)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("writer", '{"need":"周末双人活动"}')], finish_reason="tool_calls"),
        TextResponse(content="完成", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="x", registry=reg, provider=provider)

    assert calls == [{"need": "周末双人活动"}]
    assert not any("[入参校验失败]" in s.content for s in res.steps)


def test_no_schema_constraints_skips_validation():
    calls = []

    async def handler(args, ctx):
        calls.append(args)
        return "ok"

    reg = _reg(handler, "free", {"type": "object", "properties": {}})
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("free", "{}")], finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="x", registry=reg, provider=provider)

    assert calls == [{}]  # 无约束 → 不拦，照常执行


def test_validation_precedes_approval_gate():
    """受审批工具入参非法时，应回灌校验错误、不进入审批闸（别为非法参数弹确认）。"""
    async def handler(args, ctx):
        return "made"

    reg = _reg(handler, "spender", _SCHEMA_REQ, requires_approval=True, approval_class="spend")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("spender", "{}")], finish_reason="tool_calls"),
        TextResponse(content="我改下参数", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="x", registry=reg, provider=provider)

    assert any(s.type == "tool_result" and "[入参校验失败]" in s.content for s in res.steps)
    assert not any(s.type == "approval_request" for s in res.steps)
