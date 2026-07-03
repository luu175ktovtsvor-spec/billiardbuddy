# -*- coding: utf-8 -*-
"""F7② 抽取器置信度分流:high 走 auto(consolidate+_replace_store_memory,即时生效)，
medium/low 逐条进 pending 收件箱(人审后才生效)，不进 auto、不即时注入。

不碰 agent.py(把 AI 交付喂学习是独立单 F-3b)；只测 memory_service.remember() 的落库路由。
DB 用例走内存 SQLite + 真 metadata.create_all，monkeypatch 掉 LLM 抽取(不联网不花钱)，
沿用 test_store_memory_manual.py 里验证过的 session_maker 写法，不重造 fixture。
"""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import services.memory_service as ms
from db.base import Base
from services.memory_service import Memory
import models  # noqa: F401  触发全部模型注册（建表用）
from models.store_memory import StoreMemory


@pytest.fixture
async def session_maker():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


# ── 1. _EXTRACT_SYS 路由措辞 ─────────────────────────────────────

def test_extract_sys_has_confidence_routing_guidance():
    """F7②:抽取器 system prompt 补充置信度路由原则——客观事实高置信，
    拿不准/信息不全的标低置信交人工确认、别硬记成高置信。"""
    assert "低置信" in ms._EXTRACT_SYS
    assert "人工确认" in ms._EXTRACT_SYS or "人审" in ms._EXTRACT_SYS
    assert "confidence" in ms._EXTRACT_SYS  # 已有的字段名，路由原则应围绕它写


# ── 2. remember() 按置信度分流落库 ────────────────────────────────

async def test_high_confidence_goes_auto_medium_low_goes_pending(session_maker, monkeypatch):
    """改好了:混合置信度的抽取结果——high 立刻进 auto(load_store_memory 能读到、即时生效)；
    medium/low 进 pending 收件箱(source="pending")，不进 auto、不被 load_store_memory 带出。"""
    sid = uuid.uuid4()

    async def fake_extract(text, store=None):
        return [
            Memory("semantic", "门店台费60元每小时", "high"),
            Memory("semantic", "老板可能主打竞技客群", "medium"),
            Memory("episodic", "这次活动细节还不确定", "low"),
        ]

    monkeypatch.setattr(ms, "extract_memories", fake_extract)

    async with session_maker() as db:
        result = await ms.remember(db, sid, "随便聊了几句")

    # high 立刻生效：load_store_memory 能读到
    async with session_maker() as db:
        loaded = await ms.load_store_memory(db, sid)
    contents = [m.content for m in loaded]
    assert "门店台费60元每小时" in contents
    assert "老板可能主打竞技客群" not in contents
    assert "这次活动细节还不确定" not in contents

    # medium/low 落库为 pending，high 落库为 auto
    async with session_maker() as db:
        rows = (await db.execute(select(StoreMemory).where(StoreMemory.store_id == sid))).scalars().all()
    by_content = {r.content: r.source for r in rows}
    assert by_content.get("门店台费60元每小时") == "auto"
    assert by_content.get("老板可能主打竞技客群") == "pending"
    assert by_content.get("这次活动细节还不确定") == "pending"

    # remember() 返回值(即时可注入的店脑)里也不该带 pending 的两条
    ret_contents = [m.content for m in result]
    assert "门店台费60元每小时" in ret_contents
    assert "老板可能主打竞技客群" not in ret_contents
    assert "这次活动细节还不确定" not in ret_contents


async def test_all_low_confidence_no_auto_change_but_pending_added(session_maker, monkeypatch):
    """改好了:全是中低置信度时——auto 记忆不变(没有 high 可即时学)，但 pending 候选照常入库
    (拿不准的事实排队等人审，不是直接丢弃)。"""
    sid = uuid.uuid4()

    async def fake_extract(text, store=None):
        return [Memory("semantic", "拿不准的信息", "low")]

    monkeypatch.setattr(ms, "extract_memories", fake_extract)

    async with session_maker() as db:
        result = await ms.remember(db, sid, "随便聊了几句")
    assert result == []  # 没有已存在的 auto 记忆，也没新增 high → 店脑不变

    async with session_maker() as db:
        rows = (await db.execute(select(StoreMemory).where(StoreMemory.store_id == sid))).scalars().all()
    assert len(rows) == 1
    assert rows[0].source == "pending"
    assert rows[0].content == "拿不准的信息"


async def test_confidence_case_insensitive_routing(session_maker, monkeypatch):
    """审查 Minor #3:置信度路由用 confidence == "high" 精确匹配，模型偶吐 "High"/"HIGH"
    这类大小写变体时不该静默落 pending——路由判定要做大小写归一，"High" 仍应走 auto。"""
    sid = uuid.uuid4()

    async def fake_extract(text, store=None):
        return [Memory("semantic", "门店台费60元每小时", "High")]

    monkeypatch.setattr(ms, "extract_memories", fake_extract)

    async with session_maker() as db:
        await ms.remember(db, sid, "随便聊了几句")

    async with session_maker() as db:
        rows = (await db.execute(select(StoreMemory).where(StoreMemory.store_id == sid))).scalars().all()
    by_content = {r.content: r.source for r in rows}
    assert by_content.get("门店台费60元每小时") == "auto"


async def test_manual_untouched_by_confidence_routing(session_maker, monkeypatch):
    """边界:置信度分流只影响新抽取出的记忆走 auto 还是 pending，
    manual(老板亲定的店规矩)全程不受影响、不被牵连。"""
    sid = uuid.uuid4()
    async with session_maker() as db:
        db.add(StoreMemory(store_id=sid, type="operational", content="周一闭店",
                           confidence="high", source="manual"))
        await db.commit()

    async def fake_extract(text, store=None):
        return [Memory("semantic", "新学到的低置信信息", "low")]

    monkeypatch.setattr(ms, "extract_memories", fake_extract)

    async with session_maker() as db:
        result = await ms.remember(db, sid, "随便聊了几句")

    assert any(m.source == "manual" and m.content == "周一闭店" for m in result)
    async with session_maker() as db:
        rows = (await db.execute(select(StoreMemory).where(StoreMemory.store_id == sid))).scalars().all()
    by_src: dict[str, list[str]] = {}
    for r in rows:
        by_src.setdefault(r.source, []).append(r.content)
    assert by_src.get("manual") == ["周一闭店"]
    assert "新学到的低置信信息" in by_src.get("pending", [])
