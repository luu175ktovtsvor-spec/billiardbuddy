"""权限/自主级别测试（"最高权限·免确认"机制）。

锁住 ctx.permission_mode 对 requires_approval 工具的影响：
- ask        ：文件类/花钱类都弹确认、不执行（默认，最稳）
- auto_files ：文件类(可逆、自动备份)免确认直接执行；花钱类仍弹确认
- full       ：所有动作(含花钱)免确认自动执行
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.loop import run_agent_loop
from services.agent.registry import Tool, ToolRegistry
from services.agent.context import AgentContext


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _provider_calls_then_done(tool_name):
    """首轮要求调 tool_name，之后给最终答复（避免跑到 max_turns）。"""
    state = {"turn": 0}

    class _P(MockTextProvider):
        async def generate(self, request):
            state["turn"] += 1
            if state["turn"] == 1:
                return TextResponse(content="", model="mock",
                                    tool_calls=[_tc(tool_name)], finish_reason="tool_calls")
            return TextResponse(content="搞定", model="mock",
                                tool_calls=None, finish_reason="stop")

    return _P()


def _registry(executed):
    reg = ToolRegistry()

    async def file_handler(args, ctx):
        executed.append("file")
        return "改好了"

    async def spend_handler(args, ctx):
        executed.append("spend")
        return "花钱了"

    reg.register(Tool(name="edit_excel", description="改表",
                      parameters={"type": "object", "properties": {}},
                      handler=file_handler, requires_approval=True, approval_class="file"))
    reg.register(Tool(name="make_poster", description="生图",
                      parameters={"type": "object", "properties": {}},
                      handler=spend_handler, requires_approval=True, approval_class="spend"))
    return reg


def _has_approval(res):
    return any(s.type == "approval_request" for s in res.steps)


def _run(tool_name, mode):
    executed = []
    res = asyncio.run(run_agent_loop(
        user_message="x", registry=_registry(executed),
        provider=_provider_calls_then_done(tool_name),
        ctx=AgentContext(permission_mode=mode),
    ))
    return res, executed


def test_ask_mode_file_tool_requests_approval():
    res, executed = _run("edit_excel", "ask")
    assert _has_approval(res)          # 弹确认
    assert "file" not in executed      # 没真执行


def test_auto_files_executes_file_tool_directly():
    res, executed = _run("edit_excel", "auto_files")
    assert not _has_approval(res)      # 不弹确认
    assert "file" in executed          # 自动改了


def test_auto_files_still_asks_for_spend():
    res, executed = _run("make_poster", "auto_files")
    assert _has_approval(res)          # 花钱仍要确认
    assert "spend" not in executed


def test_full_mode_executes_spend_directly():
    res, executed = _run("make_poster", "full")
    assert not _has_approval(res)      # 全自动
    assert "spend" in executed         # 花钱也自动执行


def test_default_ctx_is_ask():
    """不传 permission_mode（默认 ask）→ 仍走审批，向后兼容。"""
    executed = []
    res = asyncio.run(run_agent_loop(
        user_message="x", registry=_registry(executed),
        provider=_provider_calls_then_done("edit_excel"),
        ctx=AgentContext(),  # 默认
    ))
    assert _has_approval(res)
    assert "file" not in executed


def test_force_confirm_tool_asks_even_in_full_mode():
    """bypass-immune（借鉴 cc-haha 权限瀑布）：force_confirm 高危工具即使在 full(全自动) 模式也强制确认、绝不自动执行。"""
    executed = []
    reg = ToolRegistry()

    async def publish_handler(args, ctx):
        executed.append("publish")
        return "已发布"

    reg.register(Tool(name="publish_post", description="发布到平台（高危·对外·不可逆）",
                      parameters={"type": "object", "properties": {}},
                      handler=publish_handler, requires_approval=True,
                      approval_class="spend", force_confirm=True))

    res = asyncio.run(run_agent_loop(
        user_message="x", registry=reg,
        provider=_provider_calls_then_done("publish_post"),
        ctx=AgentContext(permission_mode="full"),  # 最高放行模式
    ))
    assert _has_approval(res)          # full 模式也强制弹确认
    assert "publish" not in executed   # 绝不自动执行
