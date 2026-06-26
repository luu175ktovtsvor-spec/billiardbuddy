# -*- coding: utf-8 -*-
"""跨轮记忆 · 端到端（真 DB + 真 loop + 真端点 agent_chat + MockProvider）。

证明：
1. 第一轮"调工具 + 回答" → 完整轨迹落盘；第二轮同会话续问 → loop 真收到含【第一轮工具调用/结果】的 history
   （不只是文本对）→ AI 记得住前面聊的。
2. 老会话（只有 DB 行、没轨迹文件）仍能正常续聊（兜底文本对），且这一轮起开始落轨迹文件（平滑升级）。

只 monkeypatch【外部/花钱/门店画像】这类副作用依赖；loop / _load_agent_history / 落盘 / _cap_history 全走真代码。
"""
import asyncio
import json
import uuid

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from db.base import Base
from models.user import User
from models.store import Store
from models.generation import Generation

import api.v1.agent as agent_mod
import services.agent.transcript as T
from api.v1.agent import AgentChatRequest, _load_agent_history
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.registry import Tool, ToolRegistry


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _test_registry():
    reg = ToolRegistry()

    async def get_today(args, ctx):
        return "今天是周六"

    reg.register(Tool(name="get_today", description="查今天日期",
                      parameters={"type": "object", "properties": {}}, handler=get_today))
    return reg


async def _consume(resp):
    events = []
    async for chunk in resp.body_iterator:
        if isinstance(chunk, bytes):
            chunk = chunk.decode("utf-8")
        for line in chunk.splitlines():
            line = line.strip()
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[6:]))
                except ValueError:
                    pass
    return events


def _patch_common(monkeypatch, tmp_path, providers):
    """把端点的外部副作用依赖换成可控替身；轨迹目录指向 tmp。providers 按调用顺序逐个返回。"""
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))

    async def _noop_quota(*a, **k):
        return None

    async def _no_mem(*a, **k):
        return []

    monkeypatch.setattr(agent_mod, "check_quota", _noop_quota)
    monkeypatch.setattr(agent_mod, "load_store_memory", _no_mem)
    monkeypatch.setattr(agent_mod, "render_operation_profile_context", lambda store: "")
    monkeypatch.setattr(agent_mod, "_build_agent_registry", lambda billiards: _test_registry())

    _it = iter(providers)
    monkeypatch.setattr(agent_mod, "build_resilient_text_provider", lambda store: next(_it))


def _install_history_spy(monkeypatch):
    """包住真 loop：记录每次被传进去的 history，再委托真 run_agent_loop_stream。"""
    captured = {}
    real = agent_mod.run_agent_loop_stream

    def spy(**kwargs):
        captured["history"] = kwargs.get("history")
        return real(**kwargs)

    monkeypatch.setattr(agent_mod, "run_agent_loop_stream", spy)
    return captured


async def _seed(Session):
    async with Session() as db:
        u = User(id=uuid.uuid4(), phone="138", password_hash="x", name="t")
        db.add(u)
        await db.flush()
        s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
        db.add(s)
        await db.commit()
    return u, s


def _engine():
    return create_async_engine("sqlite+aiosqlite:///:memory:")


def test_second_turn_sees_first_turn_tool_trajectory(monkeypatch, tmp_path):
    # 第一轮：调 get_today + 回答；第二轮：纯回答
    p1 = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("get_today")], finish_reason="tool_calls"),
        TextResponse(content="今天周六、人多，建议搞充值送时长", model="mock", finish_reason="stop"),
    ])
    p2 = MockTextProvider(scripted=[
        TextResponse(content="你刚让我查今天日期，然后我建议你搞充值活动", model="mock", finish_reason="stop"),
    ])
    _patch_common(monkeypatch, tmp_path, [p1, p2])
    captured = _install_history_spy(monkeypatch)

    async def main():
        eng = _engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        u, s = await _seed(Session)

        async with Session() as db:
            # —— 第一轮 ——（不传 conversation_id，端点自己生成）
            resp1 = await agent_mod.agent_chat(
                body=AgentChatRequest(message="查下今天日期再给建议"), user=u, store=s, db=db)
            ev1 = await _consume(resp1)
            done1 = next(e for e in ev1 if e.get("type") == "done")
            conv_id = done1["conversation_id"]
            # 端点确实把完整轨迹落盘了：直接读 loader 应拿到工具调用 + 工具结果 + 最终答复
            hist_after_1 = await _load_agent_history(db, s, conv_id)
            assert any(m.get("role") == "assistant" and m.get("tool_calls") for m in hist_after_1), \
                "第一轮的工具调用应进轨迹"
            assert any(m.get("role") == "tool" and m.get("content") == "今天是周六" for m in hist_after_1), \
                "第一轮的工具结果应进轨迹"
            assert hist_after_1[-1]["content"] == "今天周六、人多，建议搞充值送时长"

            # —— 第二轮 ——（同会话续问，loop 应收到含第一轮工具轨迹的 history）
            resp2 = await agent_mod.agent_chat(
                body=AgentChatRequest(message="我刚让你干啥来着", conversation_id=conv_id),
                user=u, store=s, db=db)
            ev2 = await _consume(resp2)
            assert any(e.get("type") == "final" for e in ev2)

            h2 = captured["history"]
            assert h2, "第二轮必须拿到非空 history"
            # 关键断言：第二轮看得到第一轮的【工具调用】和【工具结果】（证明记住的是完整轨迹、不只是文本对）
            assert any(m.get("role") == "assistant" and m.get("tool_calls") for m in h2), \
                "第二轮 history 里应有第一轮的工具调用"
            assert any(m.get("role") == "tool" and m.get("content") == "今天是周六" for m in h2), \
                "第二轮 history 里应有第一轮的工具结果"
            # 也应看得到第一轮自己的最终答复 + 用户原话
            assert any(m.get("role") == "assistant" and m.get("content") == "今天周六、人多，建议搞充值送时长"
                       for m in h2)
            assert any(m.get("role") == "user" and "查下今天日期" in str(m.get("content")) for m in h2)

    asyncio.run(main())


def test_old_session_without_transcript_still_continues(monkeypatch, tmp_path):
    # 老会话：DB 里有一轮 Generation 行，但没有轨迹文件 → 续聊走兜底文本对、不崩，且这轮起开始落轨迹
    p = MockTextProvider(scripted=[
        TextResponse(content="上月营收 8 万，这月可以接着冲", model="mock", finish_reason="stop"),
    ])
    _patch_common(monkeypatch, tmp_path, [p])
    captured = _install_history_spy(monkeypatch)
    conv_id = uuid.uuid4()

    async def main():
        eng = _engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        u, s = await _seed(Session)

        async with Session() as db:
            # 预置老会话的一条 Generation（没有轨迹文件）
            db.add(Generation(
                id=uuid.uuid4(), store_id=s.id, user_id=u.id, type="agent", sub_type="chat",
                input_params={"message": "上个月营收咋样"}, prompt_used="x",
                result="上月营收 8 万，环比涨 12%", model_used="agent", conversation_id=conv_id,
            ))
            await db.commit()
            assert T.load_transcript(str(conv_id)) is None  # 确认此刻无轨迹文件

            resp = await agent_mod.agent_chat(
                body=AgentChatRequest(message="那这个月呢", conversation_id=str(conv_id)),
                user=u, store=s, db=db)
            ev = await _consume(resp)
            assert any(e.get("type") == "final" for e in ev)  # 正常续聊、没崩

            # 兜底：第二轮拿到的是 DB 还原的文本对（user/assistant）
            h = captured["history"]
            assert {"role": "user", "content": "上个月营收咋样"} in h
            assert {"role": "assistant", "content": "上月营收 8 万，环比涨 12%"} in h
            # 平滑升级：这一轮起把完整轨迹落盘了
            assert T.load_transcript(str(conv_id)) is not None

    asyncio.run(main())
