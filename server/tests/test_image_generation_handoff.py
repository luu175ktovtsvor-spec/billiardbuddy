"""图片成品 id 回传回归：make_poster/generate_image 出图后，图片【自己的】真实
Generation.id（不是这轮对话/会话的 id）要经 ctx 传到 loop、挂到 tool_result（同步 meta / 流式事件）
的 image_generation_ids，前端据此精确打开/追踪那张图。

照抄 test_knowledge_evidence.py 里 last_knowledge_used 的写-取-复位验证范式（同一套生命周期）：
- services/agent/tools._attach_image_generation_ids 真实按 img["generation_id"] 取值写 ctx
- AgentContext.last_image_generation_ids 字段存在、默认 None
- loop（同步 + 流式）把它挂到 tool_result 后立即复位，且不与本轮对话的 conversation_id 混淆
- 与 last_knowledge_used 同一批工具结果里能共存（两个 key 都要出现，互不覆盖）
"""
import asyncio
import uuid

from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.agent.tools import _attach_image_generation_ids
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


# ---- ① AgentContext 字段存在 ------------------------------------------------------

def test_context_has_last_image_generation_ids_field():
    ctx = AgentContext()
    assert hasattr(ctx, "last_image_generation_ids")
    assert ctx.last_image_generation_ids is None


# ---- ② _attach_image_generation_ids 真实按 generation_id 取值（不是随便什么 id）------

def test_attach_image_generation_ids_extracts_real_generation_id_not_other_fields():
    ctx = AgentContext()
    gid1, gid2 = str(uuid.uuid4()), str(uuid.uuid4())
    images = [
        {"generation_id": gid1, "poster_url": "/uploads/a.png"},
        {"generation_id": gid2, "poster_url": "/uploads/b.png"},
    ]
    _attach_image_generation_ids(ctx, images)
    assert ctx.last_image_generation_ids == [gid1, gid2]


def test_attach_image_generation_ids_noop_when_no_ids_present():
    """images 里没有 generation_id（比如工具没接上 poster_service 结果）时不误写，
    别让 ctx 上一次的残留值被以为是这次的。"""
    ctx = AgentContext()
    _attach_image_generation_ids(ctx, [{"poster_url": "/uploads/a.png"}])
    assert ctx.last_image_generation_ids is None


# ---- ③ loop（同步）把 ctx.last_image_generation_ids 挂到 tool_result.meta 后复位 -------

def test_sync_loop_attaches_image_generation_ids_to_tool_result_meta():
    """核心断言：surfaced 出去的 id 是【图片自己的】Generation.id，不是这轮对话的
    conversation_id（历史 bug：消息级 generationId 曾经其实是"本轮对话"记录、不是图）。"""
    turn_conversation_id = "chat-turn-should-not-leak-into-image-ids"
    img_gid_1, img_gid_2 = str(uuid.uuid4()), str(uuid.uuid4())

    async def make_poster_handler(args, ctx):
        images = [
            {"generation_id": img_gid_1, "poster_url": "/uploads/a.png"},
            {"generation_id": img_gid_2, "poster_url": "/uploads/b.png"},
        ]
        _attach_image_generation_ids(ctx, images)  # 真实工具（make_poster/generate_image）内部就是这样挂的
        return "已经给你出好图了"

    reg = ToolRegistry()
    reg.register(Tool(name="make_poster", description="出图", deliverable=True,
                      parameters={"type": "object", "properties": {}}, handler=make_poster_handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("make_poster")], finish_reason="tool_calls"),
        TextResponse(content="给你出好了", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext(conversation_id=turn_conversation_id)
    res = asyncio.run(run_agent_loop(user_message="做张海报", registry=reg, ctx=ctx, provider=provider))

    tr = next(s for s in res.steps if s.type == "tool_result")
    assert tr.meta == {"image_generation_ids": [img_gid_1, img_gid_2]}
    # 是图片自己的 id，不是这轮对话/会话的 id
    assert turn_conversation_id not in tr.meta["image_generation_ids"]
    # 复位：挂完即清空，防串到下一个工具
    assert ctx.last_image_generation_ids is None


def test_sync_loop_no_meta_when_tool_does_not_produce_images():
    async def plain_handler(args, ctx):
        return "写好了一段文案"  # 不出图 → tool_result 不应带 image_generation_ids

    reg = ToolRegistry()
    reg.register(Tool(name="write_op", description="写文案", deliverable=True,
                      parameters={"type": "object", "properties": {}}, handler=plain_handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("write_op")], finish_reason="tool_calls"),
        TextResponse(content="好的", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="写条朋友圈", registry=reg, provider=provider))
    tr = next(s for s in res.steps if s.type == "tool_result")
    assert tr.meta is None


def test_sync_loop_merges_image_generation_ids_with_knowledge_used():
    """同一个 tool_result 里 knowledge_used + image_generation_ids 两个 key 要能共存
    （loop.py 用 {**(_meta or {}), "image_generation_ids": ...} 合并写法，别互相覆盖）。"""
    img_gid = str(uuid.uuid4())

    async def handler(args, ctx):
        ctx.last_knowledge_used = ["赛事运营知识库"]
        _attach_image_generation_ids(ctx, [{"generation_id": img_gid, "poster_url": "/uploads/a.png"}])
        return "出好了"

    reg = ToolRegistry()
    reg.register(Tool(name="make_poster", description="出图", deliverable=True,
                      parameters={"type": "object", "properties": {}}, handler=handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("make_poster")], finish_reason="tool_calls"),
        TextResponse(content="给你出好了", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext()
    res = asyncio.run(run_agent_loop(user_message="做张海报", registry=reg, ctx=ctx, provider=provider))

    tr = next(s for s in res.steps if s.type == "tool_result")
    assert tr.meta == {"knowledge_used": ["赛事运营知识库"], "image_generation_ids": [img_gid]}
    assert ctx.last_knowledge_used is None
    assert ctx.last_image_generation_ids is None


# ---- ④ loop（流式）把 ctx.last_image_generation_ids 放进 tool_result 事件后复位 --------

def test_stream_loop_attaches_image_generation_ids_to_event():
    turn_conversation_id = "chat-turn-should-not-leak-into-image-ids"
    img_gid = str(uuid.uuid4())

    async def make_poster_handler(args, ctx):
        _attach_image_generation_ids(ctx, [{"generation_id": img_gid, "poster_url": "/uploads/a.png"}])
        return "已经给你出好图了"

    reg = ToolRegistry()
    reg.register(Tool(name="make_poster", description="出图", deliverable=True,
                      parameters={"type": "object", "properties": {}}, handler=make_poster_handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("make_poster")], finish_reason="tool_calls"),
        TextResponse(content="写好了", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext(conversation_id=turn_conversation_id)

    async def collect():
        events = []
        async for ev in run_agent_loop_stream(user_message="做张海报", registry=reg, ctx=ctx, provider=provider):
            events.append(ev)
        return events

    events = asyncio.run(collect())
    tr = next(e for e in events if e.get("type") == "tool_result")
    assert tr.get("image_generation_ids") == [img_gid]
    assert turn_conversation_id not in tr["image_generation_ids"]
    assert ctx.last_image_generation_ids is None  # 复位

    # 没出图的工具结果不应出现这个 key（本例只有一次工具调用，这里顺带确认不会误伤别的 tool_result）
    assert not any(
        e.get("type") == "tool_result" and "image_generation_ids" in e and e is not tr
        for e in events
    )
