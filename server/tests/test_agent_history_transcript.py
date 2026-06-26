# -*- coding: utf-8 -*-
"""跨轮记忆 · _load_agent_history 改造后契约：

- 有轨迹文件 → 返回【完整轨迹】（含 assistant 的 tool_calls + tool 结果），新会话走这条 → 真记得住前面。
- 无轨迹文件（老会话/读失败）→ 兜底走 DB 最近 5 轮"user/assistant 文本对"，正常续聊不崩。
- 轨迹文件优先于 DB 文本对（两者都在时用轨迹）。
- 无 conversation_id → []。
"""
import asyncio
import uuid

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from db.base import Base
from models.user import User
from models.store import Store
from models.generation import Generation
import services.agent.transcript as T
from api.v1.agent import _load_agent_history


def _trajectory(cid):
    """一段含工具轨迹的完整对话（user → assistant(tool_calls) → tool → assistant）。"""
    return [
        {"role": "user", "content": "查下今天日期再给建议"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "get_today", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "今天是周六"},
        {"role": "assistant", "content": "周六人多，建议搞个充值送时长"},
    ]


async def _seed(Session):
    async with Session() as db:
        u = User(id=uuid.uuid4(), phone="138", password_hash="x", name="t")
        db.add(u)
        await db.flush()
        s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
        db.add(s)
        await db.commit()
        return db, s, u


def _new_engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    return eng


def test_loads_full_trajectory_when_transcript_present(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))
    cid = str(uuid.uuid4())
    T.save_transcript(cid, _trajectory(cid))

    async def main():
        eng = _new_engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        _db, s, _u = await _seed(Session)
        async with Session() as db:
            hist = await _load_agent_history(db, s, cid)
        # 完整轨迹：工具调用 + 工具结果都在（不只是文本对）
        assert any(m.get("role") == "assistant" and m.get("tool_calls") for m in hist)
        tool_msgs = [m for m in hist if m.get("role") == "tool"]
        assert tool_msgs and tool_msgs[0]["content"] == "今天是周六"
        assert hist[-1]["content"] == "周六人多，建议搞个充值送时长"

    asyncio.run(main())


def test_falls_back_to_text_pairs_when_no_transcript(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))  # 空目录 → 无轨迹文件
    cid = uuid.uuid4()

    async def main():
        eng = _new_engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        _db, s, u = await _seed(Session)
        async with Session() as db:
            # 老会话：只有 Generation 行（没轨迹文件）
            db.add(Generation(
                id=uuid.uuid4(), store_id=s.id, user_id=u.id, type="agent", sub_type="chat",
                input_params={"message": "上个月营收咋样"}, prompt_used="上个月营收咋样",
                result="上月营收 8 万，环比涨 12%", model_used="agent", conversation_id=cid,
            ))
            await db.commit()
            hist = await _load_agent_history(db, s, str(cid))
        # 兜底：还原成 user/assistant 文本对，不崩
        assert hist == [
            {"role": "user", "content": "上个月营收咋样"},
            {"role": "assistant", "content": "上月营收 8 万，环比涨 12%"},
        ]

    asyncio.run(main())


def test_transcript_takes_priority_over_db(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))
    cid = uuid.uuid4()
    T.save_transcript(str(cid), _trajectory(str(cid)))  # 轨迹文件 + DB 行同在

    async def main():
        eng = _new_engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        _db, s, u = await _seed(Session)
        async with Session() as db:
            db.add(Generation(
                id=uuid.uuid4(), store_id=s.id, user_id=u.id, type="agent", sub_type="chat",
                input_params={"message": "查下今天日期再给建议"}, prompt_used="x",
                result="周六人多，建议搞个充值送时长", model_used="agent", conversation_id=cid,
            ))
            await db.commit()
            hist = await _load_agent_history(db, s, str(cid))
        # 用轨迹（看得到工具调用），而非 DB 文本对（看不到工具）
        assert any(m.get("role") == "tool" for m in hist)

    asyncio.run(main())


def test_no_conversation_id_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))

    async def main():
        eng = _new_engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        _db, s, _u = await _seed(Session)
        async with Session() as db:
            assert await _load_agent_history(db, s, None) == []

    asyncio.run(main())
