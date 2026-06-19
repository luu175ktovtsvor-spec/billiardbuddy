"""权限/自主级别测试（"最高权限·免确认"机制）。

锁住 ctx.permission_mode 对 requires_approval 工具的影响：
- ask        ：文件类/花钱类都弹确认、不执行（默认，最稳）
- auto_files ：文件类(可逆、自动备份)免确认直接执行；花钱类仍弹确认
- full       ：所有动作(含花钱)免确认自动执行
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.loop import run_agent_loop, _auto_approve
from services.agent.registry import Tool, ToolRegistry
from services.agent.context import AgentContext


def _spend_tool():
    return Tool(name="make_poster", description="生图",
                parameters={"type": "object", "properties": {}},
                handler=lambda a, c: "x", requires_approval=True, approval_class="spend")


def _file_tool():
    return Tool(name="edit_excel", description="改表",
                parameters={"type": "object", "properties": {}},
                handler=lambda a, c: "x", requires_approval=True, approval_class="file")


def test_full_mode_spend_cap_forces_confirm_after_limit(monkeypatch):
    """full(跳过确认)下花钱免确认但一轮内有上限——超上限即使 full 也强制弹确认（防批量出图静默扣费·B-5/C-1）。"""
    monkeypatch.setenv("DESKTOP_AGENT_AUTO_SPEND_LIMIT", "2")
    tool = _spend_tool()
    ctx = AgentContext(permission_mode="full")
    assert _auto_approve(tool, ctx) is True    # 第1张：自动
    assert _auto_approve(tool, ctx) is True    # 第2张：自动
    assert _auto_approve(tool, ctx) is False   # 第3张：超上限 → 强制确认
    assert ctx.auto_spend_count == 2           # 只计自动放行的花钱次数


def test_full_mode_file_tool_not_capped(monkeypatch):
    """文件类(可逆/已自动备份)不受花钱上限限制，full 下一直自动、不计数。"""
    monkeypatch.setenv("DESKTOP_AGENT_AUTO_SPEND_LIMIT", "1")
    tool = _file_tool()
    ctx = AgentContext(permission_mode="full")
    assert _auto_approve(tool, ctx) is True
    assert _auto_approve(tool, ctx) is True
    assert ctx.auto_spend_count == 0


def test_spend_cap_zero_means_full_never_auto_spends(monkeypatch):
    """上限设 0 = full 模式也从不自动花钱（等价于花钱永远先确认）。"""
    monkeypatch.setenv("DESKTOP_AGENT_AUTO_SPEND_LIMIT", "0")
    ctx = AgentContext(permission_mode="full")
    assert _auto_approve(_spend_tool(), ctx) is False
    assert ctx.auto_spend_count == 0


def test_owner_can_disable_cap_via_negative_limit():
    """老板把上限闸关掉（auto_spend_limit<0，他自己的 BYOK key/钱自担）→ full 下花钱全自动、不再拦。"""
    ctx = AgentContext(permission_mode="full", auto_spend_limit=-1)
    tool = _spend_tool()
    for _ in range(20):
        assert _auto_approve(tool, ctx) is True


def test_ctx_limit_overrides_env(monkeypatch):
    """本店上限值（ctx.auto_spend_limit，老板 UI 设的）优先于环境默认。"""
    monkeypatch.setenv("DESKTOP_AGENT_AUTO_SPEND_LIMIT", "100")
    ctx = AgentContext(permission_mode="full", auto_spend_limit=1)
    tool = _spend_tool()
    assert _auto_approve(tool, ctx) is True
    assert _auto_approve(tool, ctx) is False  # 本店上限=1 优先于环境的 100


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
