"""B-2「依据可见」回归：本次注入的行业知识名(knowledge_used)从工具经 ctx 传到 loop、
挂到 tool_result 事件，前端成品卡据此显示「依据：name1、name2」。

锁住整条链的每一环：
- _load_knowledge_for_role 返回 (text, names)，names 取自被注入知识的【大白话 name】
- generate_workbench 把 names 写进 generation.input_params["knowledge_used"]
- run_generation 即使调用方没传 knowledge_used，input_params 也恒有该键（默认空列表）
- AgentContext.last_knowledge_used 存在；loop（同步 + 流式）把它挂到 tool_result 后立即复位
"""
import asyncio
from types import SimpleNamespace

import pytest

import services.content_service as cs
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


class _FakeDB:
    """够 generate_workbench/run_generation 用的最小 AsyncSession：add 收集、commit/refresh 空转。"""
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        return None

    async def refresh(self, obj):
        # 真 refresh 会从 DB 回填；这里空转，保留内存里构造的 input_params 不被覆盖
        return None


def _stub_workbench_externals(monkeypatch, names):
    """把 generate_workbench 的重外部依赖打桩，只留它对 knowledge_used 的处理逻辑可测。"""
    async def fake_check_quota(db, store_id):
        return None

    async def fake_increment_usage(db, store_id, tokens=0):
        return None

    async def fake_brand_voice(db, store_id):
        return ""

    def fake_validate():
        return None

    def fake_load_knowledge(role, store, intent_text=""):
        return "（行业知识正文）", list(names)

    class _FakeProvider:
        async def generate(self, request):
            return SimpleNamespace(content="成品内容", model="mock", tokens_used=10)

    monkeypatch.setattr(cs, "check_quota", fake_check_quota)
    monkeypatch.setattr(cs, "increment_usage", fake_increment_usage)
    monkeypatch.setattr(cs, "get_brand_voice_context", fake_brand_voice)
    monkeypatch.setattr(cs, "_validate_provider_for_production", fake_validate)
    monkeypatch.setattr(cs, "_load_knowledge_for_role", fake_load_knowledge)
    monkeypatch.setattr(cs.ProviderFactory, "get_text_provider_for_store",
                        staticmethod(lambda store: _FakeProvider()))


# ---- ① _load_knowledge_for_role 真返回 (text, names) ----------------------------

def test_load_knowledge_returns_text_and_names():
    """真跑 _load_knowledge_for_role（不打桩）：返回二元组，names 与注入文本一一对应、是大白话名。"""
    from models.store import Store
    store = Store(name="测试球房", city="成都")
    # manager 角色声明了 required_knowledge；带场景意图触发筛选
    text, names = cs._load_knowledge_for_role("manager", store, "这周搞个月赛")
    assert isinstance(text, str) and isinstance(names, list)
    assert text.strip(), "应注入到知识正文"
    assert names, "注入了知识就应给出对应的 name 列表"
    # name 是中文大白话名，不是 knowledge.xxx 这种 key
    assert all(isinstance(n, str) and n and not n.startswith("knowledge.") for n in names)


# ---- ② generate_workbench 把 names 写进 input_params["knowledge_used"] -----------

def test_generate_workbench_records_knowledge_used(monkeypatch):
    names = ["赛事运营知识库", "门店核心运营"]
    _stub_workbench_externals(monkeypatch, names)
    from models.store import Store
    store = Store(name="测试球房", city="成都")
    user = SimpleNamespace(id="u1", my_role="manager")

    gen = asyncio.run(cs.generate_workbench(
        db=_FakeDB(), store=store, user=user,
        user_intent="这周搞个月赛", role="manager",
    ))
    assert gen.input_params["knowledge_used"] == names


def test_generate_workbench_prompt_key_path_records_knowledge_used(monkeypatch):
    """prompt_key 路径（走 _append_guardrails）同样要带 knowledge_used。"""
    names = ["赛事运营知识库"]
    _stub_workbench_externals(monkeypatch, names)
    from models.store import Store
    store = Store(name="测试球房", city="成都")
    user = SimpleNamespace(id="u1", my_role="manager")

    gen = asyncio.run(cs.generate_workbench(
        db=_FakeDB(), store=store, user=user,
        user_intent="搞个强一比赛主持", role="manager",
        prompt_key="operation.qiangyi_battle",
    ))
    assert gen.input_params["knowledge_used"] == names


# ---- ③ run_generation 恒带 knowledge_used 键（默认空列表）------------------------

def test_run_generation_always_has_knowledge_used_key(monkeypatch):
    async def fake_check_quota(db, store_id):
        return None

    async def fake_increment_usage(db, store_id, tokens=0):
        return None

    def fake_validate():
        return None

    async def fake_store_brain(db, store_id):
        return {}

    def fake_with_brain(prompt, memories, intent=""):
        return prompt

    class _FakeProvider:
        async def generate(self, request):
            return SimpleNamespace(content="x", model="mock", tokens_used=1)

    monkeypatch.setattr(cs, "check_quota", fake_check_quota)
    monkeypatch.setattr(cs, "increment_usage", fake_increment_usage)
    monkeypatch.setattr(cs, "_validate_provider_for_production", fake_validate)
    monkeypatch.setattr(cs, "load_store_memory", fake_store_brain)
    monkeypatch.setattr(cs, "with_store_brain", fake_with_brain)
    monkeypatch.setattr(cs.ProviderFactory, "get_text_provider_for_store",
                        staticmethod(lambda store: _FakeProvider()))

    from models.store import Store
    store = Store(name="测试球房", city="成都")
    user = SimpleNamespace(id="u1")

    # 调用方没传 knowledge_used → 也应兜出空列表
    gen = asyncio.run(cs.run_generation(
        db=_FakeDB(), store=store, user=user,
        prompt="写点啥", gen_type="batch", sub_type="moments",
        input_params={"kind": "moments"},
    ))
    assert gen.input_params["knowledge_used"] == []

    # 调用方传了 → 原样保留
    gen2 = asyncio.run(cs.run_generation(
        db=_FakeDB(), store=store, user=user,
        prompt="写点啥", gen_type="batch", sub_type="moments",
        input_params={"kind": "moments", "knowledge_used": ["群运营知识库"]},
    ))
    assert gen2.input_params["knowledge_used"] == ["群运营知识库"]


# ---- ④ AgentContext 字段存在 ----------------------------------------------------

def test_context_has_last_knowledge_used_field():
    ctx = AgentContext()
    assert hasattr(ctx, "last_knowledge_used")
    assert ctx.last_knowledge_used is None


# ---- ⑤ loop（同步）把 ctx.last_knowledge_used 挂到 tool_result.meta 后复位 ----------

def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def test_sync_loop_attaches_knowledge_used_to_tool_result_meta():
    async def deliverable_handler(args, ctx):
        ctx.last_knowledge_used = ["赛事运营知识库", "门店核心运营"]  # 模拟 deliverable 工具注入知识
        return "成品文案"

    reg = ToolRegistry()
    reg.register(Tool(name="write_op", description="写文案", deliverable=True,
                      parameters={"type": "object", "properties": {}}, handler=deliverable_handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("write_op")], finish_reason="tool_calls"),
        TextResponse(content="给你写好了", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext()
    res = asyncio.run(run_agent_loop(user_message="写条朋友圈", registry=reg, ctx=ctx, provider=provider))

    tr = next(s for s in res.steps if s.type == "tool_result")
    assert tr.meta == {"knowledge_used": ["赛事运营知识库", "门店核心运营"]}
    # 复位：挂完即清空，防串到下一个工具
    assert ctx.last_knowledge_used is None


def test_sync_loop_no_meta_when_no_knowledge():
    async def plain_handler(args, ctx):
        return "查询结果"  # 不注入知识 → tool_result 不应有 meta

    reg = ToolRegistry()
    reg.register(Tool(name="lookup", description="查",
                      parameters={"type": "object", "properties": {}}, handler=plain_handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("lookup")], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="查个东西", registry=reg, provider=provider))
    tr = next(s for s in res.steps if s.type == "tool_result")
    assert tr.meta is None


# ---- ⑤ loop（流式）把 ctx.last_knowledge_used 放进 tool_result 事件后复位 -----------

def test_stream_loop_attaches_knowledge_used_to_event():
    async def deliverable_handler(args, ctx):
        ctx.last_knowledge_used = ["赛事运营知识库"]
        return "成品文案"

    reg = ToolRegistry()
    reg.register(Tool(name="write_op", description="写文案", deliverable=True,
                      parameters={"type": "object", "properties": {}}, handler=deliverable_handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("write_op")], finish_reason="tool_calls"),
        TextResponse(content="写好了", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext()

    async def collect():
        events = []
        async for ev in run_agent_loop_stream(user_message="写条朋友圈", registry=reg, ctx=ctx, provider=provider):
            events.append(ev)
        return events

    events = asyncio.run(collect())
    tr = next(e for e in events if e.get("type") == "tool_result")
    assert tr.get("knowledge_used") == ["赛事运营知识库"]
    assert ctx.last_knowledge_used is None  # 复位

    # 没注入知识的工具，事件里不应出现 knowledge_used 键
    assert not any(
        e.get("type") == "tool_result" and "knowledge_used" in e and e is not tr
        for e in events
    )
