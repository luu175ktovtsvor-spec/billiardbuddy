"""P0.3 Agent 工具注册表骨架。

锁住：
- Tool 数据结构 + to_openai_schema 导出成 DeepSeek/OpenAI tools 格式
- ToolRegistry 注册/查找/去重/导出
- @tool 装饰器登记
- requires_approval 标记（审批闸 P2 用，先存）
- demo 只读工具 get_current_date 真实可跑（证明 handler 链路通）
"""
import asyncio

from services.agent.registry import Tool, ToolRegistry, tool


async def _echo_handler(args, ctx):
    return f"echo:{args.get('text', '')}"


def _make_tool(name="echo"):
    return Tool(
        name=name,
        description="回显输入",
        parameters={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        handler=_echo_handler,
    )


def test_register_and_get():
    reg = ToolRegistry()
    t = _make_tool()
    reg.register(t)
    assert reg.get("echo") is t
    assert reg.get("nope") is None


def test_duplicate_register_raises():
    reg = ToolRegistry()
    reg.register(_make_tool())
    try:
        reg.register(_make_tool())
        assert False, "重复注册同名工具应报错"
    except ValueError:
        pass


def test_to_openai_tools_format():
    reg = ToolRegistry()
    reg.register(_make_tool())
    assert reg.to_openai_tools() == [{
        "type": "function",
        "function": {
            "name": "echo",
            "description": "回显输入",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    }]


def test_handler_is_awaitable():
    reg = ToolRegistry()
    reg.register(_make_tool())
    out = asyncio.run(reg.get("echo").handler({"text": "hi"}, None))
    assert out == "echo:hi"


def test_decorator_registers_into_given_registry():
    reg = ToolRegistry()

    @tool(name="ping", description="ping 测试", parameters={"type": "object", "properties": {}}, registry=reg)
    async def ping(args, ctx):
        return "pong"

    assert reg.get("ping") is not None
    assert asyncio.run(reg.get("ping").handler({}, None)) == "pong"


def test_requires_approval_defaults_false():
    assert _make_tool().requires_approval is False


def test_builtin_demo_tool_current_date():
    """demo 只读工具：返回北京日期，证明真实 handler 跑得通且已登记到默认注册表。"""
    from core.timezone import business_today
    from services.agent.registry import default_registry
    from services.agent.tools import get_current_date  # noqa: F401  导入即注册

    out = asyncio.run(get_current_date({}, None))
    assert business_today().isoformat() in out
    assert default_registry.get("get_current_date") is not None


def test_deliverable_names_from_registry():
    """deliverable 标记跟着工具走；deliverable_names() 只收 deliverable=True 的，是成品白名单单一来源。"""
    reg = ToolRegistry()
    reg.register(Tool(name="good", description="成品", parameters={}, handler=_echo_handler, deliverable=True))
    reg.register(Tool(name="probe", description="只读", parameters={}, handler=_echo_handler, read_only=True))
    assert reg.deliverable_names() == {"good"}


def test_builtin_deliverable_tools_derived_includes_write_batch():
    """DELIVERABLE_TOOLS 从工具的 deliverable 标记自动派生（根治旧手抄白名单漏登 write_batch 的 bug）；
    感知/找场景类不算成品。"""
    from services.agent.tools import DELIVERABLE_TOOLS

    assert "write_batch" in DELIVERABLE_TOOLS  # 曾漏登的那个，现在由标记保证不再漏
    for name in ("write_operation_content", "plan_activity", "assistant_outreach",
                 "diagnose_operation", "recommend_games", "make_platform_content", "make_groupbuy_content",
                 "make_poster"):  # make_poster 去钱味后：直接出图、当成品（海报图原样渲染），不再弹审批
        assert name in DELIVERABLE_TOOLS
    for name in ("find_scenario", "get_current_date", "get_today_recommendation"):
        assert name not in DELIVERABLE_TOOLS
