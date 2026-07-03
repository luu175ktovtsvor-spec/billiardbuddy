"""F4 Focus Chain 进度清单（抄 Cline 三件套）。

锁住：
1. Schema：`task_progress` 无条件注入每个工具的 parameters（与审批闸 2.0 的 `security_risk` 并存，
   两者都进 properties、互不覆盖）。
2. 纯函数：`_pop_task_progress`（剥离不进 handler/签名）、`parse_progress_markdown`（markdown 复选清单
   → 结构化列表）、`format_todo_checklist`（结构化列表 → 人话展示文本，todo_write 同款渲染）、
   `_update_task_progress`（更新 ctx.todos + 维护"连续几次没更新"计数）。
3. 双状态机集成（同步 run_agent_loop / 流式 run_agent_loop_stream，`_plan_tool_call` 共用判定）：
   - 任意工具调用带 task_progress → 摘出来更新 ctx、不传进 handler、吐 todo_update 事件/步骤；
     不管该调用最终是正常执行还是待审批/被拒/入参错误，只要带了清单就该更新。
   - todo_write 工具调用（另一条更新路径）同样清计数、吐 todo_update；给了无效清单不算数。
   - 连续 6 次工具调用都没更新 → 下一轮调模型前尾部注入带百分比的提醒；提醒后计数清零、不刷屏。
"""
import asyncio
import json

from services.agent.context import AgentContext
from services.agent.loop import (
    _maybe_remind_progress,
    _pop_task_progress,
    _PROGRESS_REMIND_EVERY,
    _todos_percent,
    _update_task_progress,
    format_todo_checklist,
    parse_progress_markdown,
    run_agent_loop,
    run_agent_loop_stream,
)
from services.agent.registry import Tool, ToolRegistry, default_registry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _registry_with(handler, name="do_step", **tool_kwargs):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="测试工具",
                      parameters={"type": "object", "properties": {}}, handler=handler, **tool_kwargs))
    return reg


class _RecordingProvider(MockTextProvider):
    """按脚本回复，同时记录每次调用时收到的 messages 快照（断言"提醒真注入进下一轮请求"用）。"""

    def __init__(self, scripted):
        super().__init__(scripted)
        self.seen: list[list[dict]] = []

    async def generate(self, request):
        self.seen.append([dict(m) for m in request.messages])
        return await super().generate(request)

    async def generate_stream(self, request, **sinks):
        self.seen.append([dict(m) for m in request.messages])
        async for tok in super().generate_stream(request, **sinks):
            yield tok


async def _collect(agen):
    return [ev async for ev in agen]


# ══════════════════════════════ 甲：schema 无条件注入 + 与 security_risk 共存 ══════════════════════════════

def test_task_progress_property_injected_unconditionally():
    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    schema = reg.to_openai_tools()[0]
    prop = schema["function"]["parameters"]["properties"]["task_progress"]
    assert prop["type"] == "string"


def test_task_progress_and_security_risk_coexist_in_schema():
    """两个自评/元数据字段都进 properties、互不覆盖——registry.py to_openai_schema 分两行赋值，
    不是"最后写的那个赢"。"""
    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="x",
                      parameters={"type": "object", "properties": {"x": {"type": "string"}}},
                      handler=lambda a, c: None))
    props = reg.to_openai_tools()[0]["function"]["parameters"]["properties"]
    assert set(props.keys()) == {"x", "security_risk", "task_progress"}


# ══════════════════════════════ 乙：纯函数 ══════════════════════════════

def test_pop_task_progress_strips_and_returns_value():
    args = {"a": 1, "task_progress": "- [x] 已做"}
    assert _pop_task_progress(args) == "- [x] 已做"
    assert "task_progress" not in args, "剥离后不该留在 args 里（防污染 handler/签名/防打转 key）"


def test_pop_task_progress_blank_or_missing_is_none():
    assert _pop_task_progress({"task_progress": "   "}) is None
    assert _pop_task_progress({}) is None
    assert _pop_task_progress({"task_progress": 123}) is None  # 幻觉出非字符串类型


def test_parse_progress_markdown_basic():
    todos = parse_progress_markdown("- [x] 已做第一步\n- [ ] 待做第二步\n* [X] 大写X也算完成")
    assert todos == [
        {"task": "已做第一步", "status": "done"},
        {"task": "待做第二步", "status": "pending"},
        {"task": "大写X也算完成", "status": "done"},
    ]


def test_parse_progress_markdown_ignores_non_checklist_lines():
    todos = parse_progress_markdown("这是一段说明文字\n- [x] 真正的清单项\n随便写的一行")
    assert todos == [{"task": "真正的清单项", "status": "done"}]


def test_parse_progress_markdown_invalid_returns_empty_list():
    assert parse_progress_markdown("完全没有清单格式的一段话") == []
    assert parse_progress_markdown("") == []
    assert parse_progress_markdown(None) == []  # 故障安全：非字符串不抛错


def test_format_todo_checklist_matches_todo_write_style():
    text = format_todo_checklist([{"task": "写正文", "status": "done"}, {"task": "配图", "status": "pending"}])
    assert text == "任务清单（共 2 步，已完成 1 步）：\n☑ 写正文\n☐ 配图"


def test_todos_percent():
    assert _todos_percent([{"status": "done"}, {"status": "pending"}, {"status": "done"}]) == (2, 3)
    assert _todos_percent([]) is None
    assert _todos_percent(None) is None


def test_update_task_progress_none_increments_counter():
    ctx = AgentContext()
    assert _update_task_progress(ctx, None) is None
    assert ctx.requests_since_progress == 1
    assert _update_task_progress(ctx, None) is None
    assert ctx.requests_since_progress == 2


def test_update_task_progress_valid_resets_counter_and_updates_ctx():
    ctx = AgentContext(requests_since_progress=5)
    text = _update_task_progress(ctx, "- [x] 已做\n- [ ] 待做")
    assert text == "任务清单（共 2 步，已完成 1 步）：\n☑ 已做\n☐ 待做"
    assert ctx.requests_since_progress == 0
    assert ctx.todos == [{"task": "已做", "status": "done"}, {"task": "待做", "status": "pending"}]
    assert ctx.task_progress == "- [x] 已做\n- [ ] 待做"


def test_update_task_progress_unparseable_markdown_counts_as_no_update():
    """贴了 task_progress 但解析不出合法清单项（格式不对）→ 仍按"没更新"计数，
    不能让"格式差一点"悄悄被当成已更新（否则提醒机制永远不会触发）。"""
    ctx = AgentContext()
    assert _update_task_progress(ctx, "随便写的一段话，不是清单格式") is None
    assert ctx.requests_since_progress == 1
    assert ctx.todos == []


# ══════════════════════════════ 丙：提醒（_maybe_remind_progress 单测） ══════════════════════════════

def test_maybe_remind_progress_below_threshold_noop():
    ctx = AgentContext(requests_since_progress=_PROGRESS_REMIND_EVERY - 1)
    messages = []
    assert _maybe_remind_progress(messages, ctx) is False
    assert messages == []


def test_maybe_remind_progress_at_threshold_injects_and_resets():
    ctx = AgentContext(requests_since_progress=_PROGRESS_REMIND_EVERY)
    messages = [{"role": "user", "content": "原有历史"}]
    assert _maybe_remind_progress(messages, ctx) is True
    assert len(messages) == 2
    assert messages[-1]["role"] == "user"
    assert "连续 6 次工具调用" in messages[-1]["content"]
    assert ctx.requests_since_progress == 0  # 提醒后清零，不刷屏


def test_maybe_remind_progress_includes_percentage_when_todos_exist():
    ctx = AgentContext(requests_since_progress=_PROGRESS_REMIND_EVERY,
                        todos=[{"task": "a", "status": "done"}, {"task": "b", "status": "pending"},
                               {"task": "c", "status": "pending"}, {"task": "d", "status": "done"}])
    messages = []
    _maybe_remind_progress(messages, ctx)
    assert "2/4" in messages[-1]["content"]
    assert "50%" in messages[-1]["content"]


# ══════════════════════════════ 丁：双状态机集成 —— task_progress 参数（任意工具） ══════════════════════════════

def test_stream_task_progress_on_tool_call_emits_todo_update_and_hides_from_handler():
    calls = []

    async def handler(args, ctx):
        calls.append(dict(args))
        return "做完了"

    reg = _registry_with(handler)
    ctx = AgentContext()
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("do_step", json.dumps({"task_progress": "- [x] 第一步\n- [ ] 第二步"}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="做点事", registry=reg, ctx=ctx, provider=provider)))

    # handler 拿到的 args 里不该有 task_progress（不是工具真参数）
    assert calls == [{}]
    # 吐了 todo_update 事件（在 _plan_tool_call 判定完就吐，不管该调用走哪个分支，所以先于该次
    # 调用自己的 tool_call/tool_result；有它 + 有正常的 tool_result 即可，不强求两者的先后关系）。
    todo_events = [e for e in events if e["type"] == "todo_update"]
    assert len(todo_events) == 1
    assert todo_events[0]["content"] == "任务清单（共 2 步，已完成 1 步）：\n☑ 第一步\n☐ 第二步"
    types = [e["type"] for e in events]
    assert "tool_call" in types and "tool_result" in types
    # ctx 状态真被更新（ctx.todos 不再是死状态）
    assert ctx.todos == [{"task": "第一步", "status": "done"}, {"task": "第二步", "status": "pending"}]
    assert ctx.requests_since_progress == 0


def test_sync_task_progress_on_tool_call_emits_todo_update_step_and_hides_from_handler():
    """非流式版对齐：同一份判定逻辑（_plan_tool_call）驱动，双状态机都要生效。"""
    calls = []

    async def handler(args, ctx):
        calls.append(dict(args))
        return "做完了"

    reg = _registry_with(handler)
    ctx = AgentContext()
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("do_step", json.dumps({"task_progress": "- [x] 第一步"}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    result = asyncio.run(run_agent_loop(user_message="做点事", registry=reg, ctx=ctx, provider=provider))

    assert calls == [{}]
    todo_steps = [s for s in result.steps if s.type == "todo_update"]
    assert len(todo_steps) == 1
    assert todo_steps[0].content == "任务清单（共 1 步，已完成 1 步）：\n☑ 第一步"
    assert ctx.todos == [{"task": "第一步", "status": "done"}]


def test_task_progress_and_security_risk_independent_on_same_call():
    """同一次调用里两个自评字段都要各自被摘出来、互不影响（不能因为处理 security_risk 就漏摘 task_progress，反之亦然）。"""
    calls = []

    async def handler(args, ctx):
        calls.append(dict(args))
        return "ok"

    reg = _registry_with(handler)
    ctx = AgentContext()
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("do_step", json.dumps({"task_progress": "- [x] 步骤", "security_risk": "low"}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    asyncio.run(run_agent_loop(user_message="测试", registry=reg, ctx=ctx, provider=provider))

    assert calls == [{}], "两个自评字段都不该混进 handler 收到的 args"
    assert ctx.todos == [{"task": "步骤", "status": "done"}]


def test_task_progress_still_recorded_when_call_needs_approval():
    """待确认（审批闸）分支同样要带出 progress_snapshot——模型贴了清单就该让老板看到最新进度，
    不管这次调用本身最终是否被执行。"""
    async def handler(args, ctx):
        return "不该被执行"

    reg = _registry_with(handler, requires_approval=True)
    ctx = AgentContext()
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("do_step", json.dumps({"task_progress": "- [x] 步骤一"}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="测试", registry=reg, ctx=ctx, provider=provider)))

    assert any(e["type"] == "todo_update" for e in events)
    assert any(e["type"] == "approval_request" for e in events)
    assert ctx.todos == [{"task": "步骤一", "status": "done"}]


# ══════════════════════════════ 戊：双状态机集成 —— todo_write 归并同一份真相源 ══════════════════════════════

def _todo_write_registry():
    reg = ToolRegistry()
    reg.register(default_registry.get("todo_write"))
    return reg


def test_stream_todo_write_resets_counter_and_emits_todo_update():
    ctx = AgentContext(requests_since_progress=3)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("todo_write", json.dumps({"todos": ["列大纲", "写正文"]}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="写篇文章", registry=_todo_write_registry(), ctx=ctx, provider=provider)))

    todo_events = [e for e in events if e["type"] == "todo_update"]
    assert len(todo_events) == 1
    assert "列大纲" in todo_events[0]["content"] and "写正文" in todo_events[0]["content"]
    assert ctx.requests_since_progress == 0


def test_sync_todo_write_resets_counter_and_emits_todo_update_step():
    ctx = AgentContext(requests_since_progress=3)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("todo_write", json.dumps({"todos": ["列大纲"]}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    result = asyncio.run(run_agent_loop(user_message="写篇文章", registry=_todo_write_registry(),
                                        ctx=ctx, provider=provider))
    todo_steps = [s for s in result.steps if s.type == "todo_update"]
    assert len(todo_steps) == 1
    assert ctx.requests_since_progress == 0


def test_todo_write_invalid_args_does_not_falsely_reset_counter():
    """todo_write 给了空清单（校验失败）时不算"更新过"，别悄悄清零计数——否则模型光调用不给内容也能糊弄过提醒。"""
    ctx = AgentContext(requests_since_progress=3)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[
            _tc("todo_write", json.dumps({"todos": []}))
        ], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="写篇文章", registry=_todo_write_registry(), ctx=ctx, provider=provider)))

    assert not any(e["type"] == "todo_update" for e in events)
    assert ctx.requests_since_progress == 4  # 走的是"没更新"计数路径（+1），不是重置


# ══════════════════════════════ 己：请求数提醒——真跑循环、多轮无更新 ══════════════════════════════

def _n_tool_call_responses(n, name="do_step", finish_text="收尾"):
    resp = [TextResponse(content="", model="mock", tool_calls=[_tc(name, "{}", call_id=f"c{i}")],
                         finish_reason="tool_calls") for i in range(n)]
    resp.append(TextResponse(content=finish_text, model="mock", finish_reason="stop"))
    return resp


def test_stream_reminder_injected_after_six_calls_without_progress():
    async def handler(args, ctx):
        return "做完一步"

    reg = _registry_with(handler)
    ctx = AgentContext()
    provider = _RecordingProvider(_n_tool_call_responses(_PROGRESS_REMIND_EVERY))
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="干活", registry=reg, ctx=ctx, provider=provider)))

    # 第 7 轮（下标 6）发给模型的请求里，尾部应该有提醒消息
    seventh_request = provider.seen[_PROGRESS_REMIND_EVERY]
    assert seventh_request[-1]["role"] == "user"
    assert "连续 6 次工具调用" in seventh_request[-1]["content"]
    assert ctx.requests_since_progress == 0


def test_sync_reminder_injected_after_six_calls_without_progress():
    """非流式版对齐：同一份 _maybe_remind_progress 两处都调用。"""
    async def handler(args, ctx):
        return "做完一步"

    reg = _registry_with(handler)
    ctx = AgentContext()
    provider = _RecordingProvider(_n_tool_call_responses(_PROGRESS_REMIND_EVERY))
    asyncio.run(run_agent_loop(user_message="干活", registry=reg, ctx=ctx, provider=provider))

    seventh_request = provider.seen[_PROGRESS_REMIND_EVERY]
    assert seventh_request[-1]["role"] == "user"
    assert "连续 6 次工具调用" in seventh_request[-1]["content"]
    assert ctx.requests_since_progress == 0


def test_reminder_not_triggered_before_threshold():
    async def handler(args, ctx):
        return "做完一步"

    reg = _registry_with(handler)
    ctx = AgentContext()
    provider = _RecordingProvider(_n_tool_call_responses(_PROGRESS_REMIND_EVERY - 1))
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="干活", registry=reg, ctx=ctx, provider=provider)))

    for req in provider.seen:
        assert not any("连续" in (m.get("content") or "") and "工具调用" in (m.get("content") or "")
                       for m in req if isinstance(m.get("content"), str))


def test_task_progress_call_resets_streak_and_avoids_reminder():
    """第 3 次调用带了 task_progress → 计数清零；接着再 5 次不带（总共没到连续 6 次没更新）→ 不该提醒。"""
    async def handler(args, ctx):
        return "做完一步"

    reg = _registry_with(handler)
    ctx = AgentContext()
    scripted = [
        TextResponse(content="", model="mock", tool_calls=[_tc("do_step", "{}", call_id="c1")], finish_reason="tool_calls"),
        TextResponse(content="", model="mock", tool_calls=[_tc("do_step", "{}", call_id="c2")], finish_reason="tool_calls"),
        TextResponse(content="", model="mock", tool_calls=[
            _tc("do_step", json.dumps({"task_progress": "- [x] 已做三步"}), call_id="c3")
        ], finish_reason="tool_calls"),
        TextResponse(content="", model="mock", tool_calls=[_tc("do_step", "{}", call_id="c4")], finish_reason="tool_calls"),
        TextResponse(content="", model="mock", tool_calls=[_tc("do_step", "{}", call_id="c5")], finish_reason="tool_calls"),
        TextResponse(content="", model="mock", tool_calls=[_tc("do_step", "{}", call_id="c6")], finish_reason="tool_calls"),
        TextResponse(content="", model="mock", tool_calls=[_tc("do_step", "{}", call_id="c7")], finish_reason="tool_calls"),
        TextResponse(content="收尾", model="mock", finish_reason="stop"),
    ]
    provider = _RecordingProvider(scripted)
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="干活", registry=reg, ctx=ctx, provider=provider)))

    for req in provider.seen:
        for m in req:
            content = m.get("content")
            if isinstance(content, str):
                assert "连续" not in content or "工具调用" not in content
    # 清零后只累计了 4 次（c4~c7），没到阈值
    assert ctx.requests_since_progress == 4
