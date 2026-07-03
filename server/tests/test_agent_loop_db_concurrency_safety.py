"""F-7 复审修复（Critical 竞态）：只读并发分组不能再信 `Tool.read_only=True`——它只代表"无副作用、
可安全重复查"，不代表"可以被 asyncio.gather 并发跑"。审计发现部分 read_only=True 的真实工具
（get_today_recommendation/recall_my_content/diagnose_from_pos）handler 内部 `await ctx.db.execute(...)`
（AsyncSession），而 AsyncSession **不允许被多个协程并发操作**。

本文件用【真实 AsyncSession】（sqlite+aiosqlite，同 tests/conftest.py 一样的驱动栈）复现问题、验证
修复，不用 mock/db=None——因为这个 bug 的本质就是 SQLAlchemy AsyncSession 自身的并发保护机制
（`InvalidRequestError: This session is provisioning a new connection; concurrent operations are not
permitted`），mock 掉 db 根本测不出这条竞态。

⚠️ 实测发现（写测试过程中意外揪出的一个坑，如实记录）：conftest.py 现成的 `db_session` fixture 会先
`async with engine.begin(): await conn.run_sync(Base.metadata.create_all)` 建表——这一步会把连接池
"预热"（先建立并归还过一次连接）。用【预热过】的 session 复现这条竞态时，20/20 次都测不出问题
（连接从暖池里取，走得够快，两个协程凑不到"都在 provisioning 半路"的窗口，race 消失）；换成【冷启动】
的 session（引擎刚建好、从没被用过，跟 `AgentContext(db=...)` 在真实一次新请求里第一次拿到的 session
更像）才能稳定复现（本地反复实测 20/20 次必炸）。故本文件【不用】conftest.py 的 `db_session`，
另起 `raw_db_session`（同样 sqlite+aiosqlite + AsyncSession 栈，只是不做预热）——这不是吹毛求疵，
是这条 Critical 竞态本身对"连接池是否已预热"敏感，用错 fixture 会把回归测试测成一个假绿灯。

覆盖：
1. 算法层：两个"真碰 ctx.db 的 read_only 工具"必须被分进独立的 solo 组（不再被误合并成并发 read 组）。
2. 行为层（真实 AsyncSession，冷启动）：模型一轮同时调用这类工具（如老板问"今天该干嘛+翻下我以前的
   文案"会同时触发 get_today_recommendation + recall_my_content）时，两者都必须拿到正确结果、不炸
   InvalidRequestError——这是修复前会真实复现的症状（老板随机收到摸不着头脑的"工具执行失败"）。
3. 行为层（真实 AsyncSession）：concurrent_safe=True 的纯 I/O 工具即使 ctx 里挂着真实 db session，
   仍然被分进并发组、真并发跑——确认本次修复没有过度保守、误伤已确认的并发收益。
4. 审计结论落地成回归闸：真实注册表里，get_today_recommendation/recall_my_content/diagnose_from_pos/
   run_subagent 的 concurrent_safe 必须恒为 False；look_up_knowledge/read_knowledge/find_scenario/
   get_current_date/web_search 必须恒为 True——防止以后有人不经意间改动误标，悄悄重新引入这个
   Critical 竞态，或悄悄吃掉已确认的并发收益都不知道。
"""
import asyncio
import time

import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from services.agent.context import AgentContext
from services.agent.loop import _ToolPlan, _group_plans_for_concurrency, run_agent_loop
from services.agent.registry import Tool, ToolRegistry, default_registry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider

# 确保这两个模块的工具都已注册进 default_registry——它们的注册【不受】DESKTOP_LOCAL 门控
# （tools.py 无条件 @tool 装饰、web_tools.py 顶部 register_web_tools() 无条件调用，见各自模块注释），
# 只是要保证本文件独立跑时也有工具可查（其它测试文件可能已经导入过，import 是幂等的、不会重复注册）。
import services.agent.tools  # noqa: F401
import services.agent.web_tools  # noqa: F401


@pytest_asyncio.fixture
async def raw_db_session():
    """真实 AsyncSession（sqlite+aiosqlite），刻意【不预热】连接池（不建表、不提前拿一次连接）——
    见模块顶部说明：conftest.py 的 `db_session` fixture 会为建表先预热连接池，反而让这条竞态测不出来。
    这里的引擎/session 全新出炉，第一次 execute() 就要现场 provision 连接，正是竞态的触发窗口。"""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        yield s
    await engine.dispose()


def _tc(name, cid):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": "{}"}}


def _db_touching_tool(name):
    """模拟审计发现的真实模式："read_only=True（确实无副作用、结果确定性只读），但 handler 内部
    真的 `await ctx.db.execute(...)`"——如 get_today_recommendation/recall_my_content。故意【不】设
    concurrent_safe（fail-safe 默认 False）。"""
    async def handler(args, ctx):
        await ctx.db.execute(text("SELECT 1"))
        return f"result-{name}"
    return Tool(name=name, description="t", parameters={"type": "object", "properties": {}},
                handler=handler, read_only=True)


# ══════════════════════════════ 算法层 ══════════════════════════════

def test_two_db_touching_readonly_tools_are_grouped_solo_not_concurrent():
    """两个连续的、真实碰 ctx.db 的 read_only 工具，分组结果必须是两个独立 solo（不是一个并发 read
    组）——这是本次修复的核心判据变化，直接对应 get_today_recommendation + recall_my_content
    同一轮被调的真实场景。"""
    reg = ToolRegistry()
    reg.register(_db_touching_tool("get_today_recommendation_like"))
    reg.register(_db_touching_tool("recall_my_content_like"))
    plans = [
        _ToolPlan(name="get_today_recommendation_like", args={}, tool_call_id="c1"),
        _ToolPlan(name="recall_my_content_like", args={}, tool_call_id="c2"),
    ]
    groups = _group_plans_for_concurrency(plans, reg)
    assert groups == [("solo", [plans[0]]), ("solo", [plans[1]])]


# ══════════════════════════════ 行为层（真实 AsyncSession） ══════════════════════════════

async def test_two_db_touching_readonly_tools_run_together_without_session_race(raw_db_session):
    """行为层·真实 AsyncSession（非 mock）：模型一轮同时调两个"读+碰 db"的工具（如老板问
    "今天该干嘛，另外翻下我以前的文案"会同时触发 get_today_recommendation + recall_my_content）——
    必须都拿到正确结果，不能撞见 InvalidRequestError。

    修复前的真实症状：这两个工具都 read_only=True，会被旧代码误合并成并发 read 组，
    asyncio.gather 同时对同一个 AsyncSession 发 execute() 必炸
    `InvalidRequestError: This session is provisioning a new connection; concurrent operations
    are not permitted`（本仓库用 sqlite+aiosqlite 实测复现率 100%，不是理论风险）——`_execute_tool`
    的 except 会把它吞成一条"[工具执行失败] ..."错误串回灌给模型，老板随机看到摸不着头脑的报错。
    """
    reg = ToolRegistry()
    reg.register(_db_touching_tool("get_today_recommendation_like"))
    reg.register(_db_touching_tool("recall_my_content_like"))
    ctx = AgentContext(db=raw_db_session)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("get_today_recommendation_like", "id1"),
                                 _tc("recall_my_content_like", "id2")],
                     finish_reason="tool_calls"),
        TextResponse(content="都答完了", model="mock", finish_reason="stop"),
    ])
    res = await run_agent_loop(user_message="今天该干嘛，另外翻下我以前的文案",
                                registry=reg, ctx=ctx, provider=provider)

    assert res.final_text == "都答完了"
    tool_msgs = [m for m in res.messages if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["id1", "id2"]
    # 两条都必须是真实结果——绝不能是"[工具执行失败]...InvalidRequestError..."（修复前的真实症状）。
    assert tool_msgs[0]["content"] == "result-get_today_recommendation_like"
    assert tool_msgs[1]["content"] == "result-recall_my_content_like"
    for m in tool_msgs:
        assert "工具执行失败" not in m["content"]
        assert "InvalidRequestError" not in m["content"]


async def test_three_db_touching_readonly_tools_still_all_succeed(raw_db_session):
    """再加一个碰 db 的工具、验证不是"凑巧两个能过"——三个连续的碰 db read_only 工具同一轮被调，
    全部各自 solo 串行执行，全部拿到正确结果。"""
    reg = ToolRegistry()
    for n in ("t1", "t2", "t3"):
        reg.register(_db_touching_tool(n))
    ctx = AgentContext(db=raw_db_session)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("t1", "id1"), _tc("t2", "id2"), _tc("t3", "id3")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    res = await run_agent_loop(user_message="x", registry=reg, ctx=ctx, provider=provider)

    tool_msgs = [m for m in res.messages if m.get("role") == "tool"]
    assert [m["content"] for m in tool_msgs] == ["result-t1", "result-t2", "result-t3"]


async def test_concurrent_safe_pure_io_tools_still_run_concurrently_with_real_ctx(raw_db_session):
    """确认本次修复没有误伤真正的并发收益：两个标了 concurrent_safe=True 的纯 I/O 工具（不碰
    ctx.db），即使 ctx 挂着一个真实 db_session（模拟真实生产 ctx 的形态——ctx 里【有】db，只是这两个
    工具不用它），仍然被分进并发 read 组、真并发跑（用 sleep 计时验证），不会因为"ctx 里挂着 db"就
    被过度保守地一律拆成 solo。"""
    timeline = {}

    def _timed(tag, delay):
        async def handler(args, ctx):
            timeline[tag] = [time.perf_counter(), None]
            await asyncio.sleep(delay)
            timeline[tag][1] = time.perf_counter()
            return f"ok-{tag}"
        return handler

    reg = ToolRegistry()
    reg.register(Tool(name="cs1", description="t", parameters={"type": "object", "properties": {}},
                       handler=_timed("cs1", 0.2), read_only=True, concurrent_safe=True))
    reg.register(Tool(name="cs2", description="t", parameters={"type": "object", "properties": {}},
                       handler=_timed("cs2", 0.2), read_only=True, concurrent_safe=True))
    ctx = AgentContext(db=raw_db_session)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("cs1", "id1"), _tc("cs2", "id2")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    start = time.perf_counter()
    res = await run_agent_loop(user_message="x", registry=reg, ctx=ctx, provider=provider)
    elapsed = time.perf_counter() - start

    assert res.final_text == "done"
    assert elapsed < 0.35  # 并发≈0.2s；串行会≈0.4s+，留足余量防慢机器抖动
    assert timeline["cs1"][0] < timeline["cs2"][1] and timeline["cs2"][0] < timeline["cs1"][1]


# ══════════════════════════════ 审计结论落地成回归闸 ══════════════════════════════

def _local_tool(name):
    """local_tools.py 的 _LOCAL_TOOLS 是模块级原始列表，注册进 default_registry 受 DESKTOP_LOCAL
    环境变量门控（云端 web 版不设）——直接查原始列表，不依赖任何环境变量/import 时机。"""
    from services.agent.local_tools import _LOCAL_TOOLS
    return next(t for t in _LOCAL_TOOLS if t.name == name)


def test_audit_db_touching_tools_are_never_concurrent_safe():
    """审计结论回归闸：这些工具的 handler 会真碰 ctx.db（AsyncSession），任何时候都不能标
    concurrent_safe=True，否则重新引入本文件复现的 Critical 竞态。"""
    assert getattr(default_registry.get("get_today_recommendation"), "concurrent_safe", False) is False
    assert getattr(_local_tool("recall_my_content"), "concurrent_safe", False) is False
    # diagnose_from_pos 是本次复审新发现的同类风险（原施工单只点名前两个）。
    assert getattr(_local_tool("diagnose_from_pos"), "concurrent_safe", False) is False


def test_audit_run_subagent_never_concurrent_safe():
    """run_subagent 内部 `sub_ctx.db = getattr(ctx, "db", None)`，与外层主循环共享【同一个】
    ctx.db，读写边界不透明——永远不能标 concurrent_safe，即使它本身 read_only=True。"""
    tool_obj = default_registry.get("run_subagent")
    assert tool_obj is not None
    assert tool_obj.read_only is True  # 既有契约不变
    assert getattr(tool_obj, "concurrent_safe", False) is False


def test_audit_confirmed_pure_io_tools_are_concurrent_safe():
    """确证纯网络/纯内存查询、不碰 ctx.db/ctx 共享可变状态的工具，应保持 concurrent_safe=True——
    防止以后有人"顺手"把这几个也改保守了、悄悄吃掉并发收益都不知道。"""
    for name in ("get_current_date", "find_scenario", "look_up_knowledge", "read_knowledge"):
        tool_obj = default_registry.get(name)
        assert tool_obj is not None, f"{name} 没注册到 default_registry（检查是否已 import services.agent.tools）"
        assert tool_obj.concurrent_safe is True, f"{name} 应为 concurrent_safe=True"
    web_search = default_registry.get("web_search")
    assert web_search is not None
    assert web_search.concurrent_safe is True


def test_audit_concurrent_safe_never_leaks_into_openai_schema():
    """concurrent_safe 是纯后端分组用字段，不该出现在发给模型的工具 schema 里（不是工具参数）。"""
    tool_obj = default_registry.get("web_search")
    schema = tool_obj.to_openai_schema()
    props = schema["function"]["parameters"]["properties"]
    assert "concurrent_safe" not in props
