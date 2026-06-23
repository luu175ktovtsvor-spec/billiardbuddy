# -*- coding: utf-8 -*-
"""A-8 店规矩可编辑层：manual(老板亲定的店规矩) vs auto(AI 学到) 的分水岭测试。

钉死三件事：
1. 老板手填(source=manual)经 remember/consolidate 学习后仍在，AI 绝不覆盖/删改。
2. 注入时 manual 始终全部进、不被相关性 cap 挤掉，且标"优先级最高"。
3. POST/PATCH API 把老板手填/手改的标成 source=manual。

DB 用例走内存 SQLite + 真 metadata.create_all，monkeypatch 掉 LLM 抽取/整合（不联网不花钱）。
"""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import services.memory_service as ms
from db.base import Base
from services.memory_service import (
    Memory,
    select_relevant_memories,
    format_memories_for_prompt,
)
import models  # noqa: F401  触发全部模型注册（建表用）
from models.store_memory import StoreMemory


# ── 1. 注入优先：纯逻辑（无 DB）────────────────────────────────────

def test_manual_always_injected_not_capped():
    """manual 记忆始终全部注入，不进 cap、不被 auto 的相关性筛选挤掉。"""
    manual = [Memory("operational", "本店周一闭店", source="manual"),
              Memory("semantic", "不卖酒", source="manual")]
    auto = [Memory("semantic", f"无关杂记{i}", source="auto") for i in range(30)]
    out = select_relevant_memories(manual + auto, "随便写个朋友圈", cap=5)
    # 两条 manual 一条不少
    assert all(m in out for m in manual)
    # auto 被 cap 收敛到 5 条
    assert len([m for m in out if m.source == "auto"]) == 5
    # manual 排在最前（最高优先 / 近因之外的强制优先）
    assert out[0].source == "manual" and out[1].source == "manual"


def test_manual_kept_even_when_no_intent():
    manual = [Memory("semantic", "店规矩A", source="manual")]
    auto = [Memory("semantic", f"a{i}", source="auto") for i in range(40)]
    out = select_relevant_memories(manual + auto, None)
    assert manual[0] in out


def test_format_marks_manual_block_highest_priority():
    mems = [Memory("operational", "周一闭店", source="manual"),
            Memory("semantic", "台费60/小时", source="auto")]
    text = format_memories_for_prompt(mems)
    assert "店主亲自定的店规矩" in text
    assert "优先级最高" in text
    assert "周一闭店" in text and "台费60/小时" in text
    # auto 那条仍在原来的"最新记忆"块里，没被打成店规矩
    auto_block = text.split("周一闭店", 1)[1]
    assert "台费60/小时" in auto_block


def test_format_no_manual_keeps_legacy_shape():
    """全是 auto 时输出与老格式一致（向后兼容，不冒出空的 manual 块）。"""
    mems = [Memory("semantic", "无包厢", source="auto")]
    text = format_memories_for_prompt(mems)
    assert "店主亲自定的店规矩" not in text
    assert "无包厢" in text


# ── 2. DB 用例：manual 不被 AI 学习覆盖 ────────────────────────────

@pytest.fixture
async def session_maker():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def test_manual_survives_remember(session_maker, monkeypatch):
    """老板手填(manual)的店规矩，经 remember(AI 学习)后仍原样在库——AI 绝不删改。"""
    sid = uuid.uuid4()

    # 预置：一条老板手填的店规矩(manual) + 一条 AI 旧记忆(auto)
    async with session_maker() as db:
        db.add(StoreMemory(store_id=sid, type="operational",
                           content="周一闭店，这是死规矩", confidence="high", source="manual"))
        db.add(StoreMemory(store_id=sid, type="semantic",
                           content="旧的AI记忆-台费50", confidence="medium", source="auto"))
        await db.commit()

    # AI 学到一条新事实，且 consolidate 故意想把所有都"整合"掉（模拟 AI 想覆盖）
    async def fake_extract(text, store=None):
        return [Memory("semantic", "新学到-台费60", source="auto")]

    async def fake_consolidate(existing, new, store=None):
        # 即便 AI 返回的整合结果里完全不含 manual 内容，manual 也不能被删
        return [Memory("semantic", "新学到-台费60", source="auto")]

    monkeypatch.setattr(ms, "extract_memories", fake_extract)
    monkeypatch.setattr(ms, "consolidate_memories", fake_consolidate)

    async with session_maker() as db:
        result = await ms.remember(db, sid, "今天台费涨到60了")

    # 返回值里 manual 还在
    assert any(m.source == "manual" and "周一闭店" in m.content for m in result)

    # 库里：manual 行原样保留，auto 被替换成新的
    async with session_maker() as db:
        rows = (await db.execute(
            select(StoreMemory).where(StoreMemory.store_id == sid)
        )).scalars().all()
    by_src = {}
    for r in rows:
        by_src.setdefault(r.source, []).append(r.content)
    assert by_src.get("manual") == ["周一闭店，这是死规矩"], "manual 店规矩被 AI 删改了！"
    assert "旧的AI记忆-台费50" not in by_src.get("auto", []), "旧 auto 应被替换"
    assert "新学到-台费60" in by_src.get("auto", [])


async def test_load_store_memory_returns_both(session_maker):
    sid = uuid.uuid4()
    async with session_maker() as db:
        db.add(StoreMemory(store_id=sid, type="semantic", content="手填的",
                           confidence="high", source="manual"))
        db.add(StoreMemory(store_id=sid, type="semantic", content="AI学的",
                           confidence="low", source="auto"))
        await db.commit()
        mems = await ms.load_store_memory(db, sid)
    srcs = {m.content: m.source for m in mems}
    assert srcs == {"手填的": "manual", "AI学的": "auto"}


# ── 3. API：POST/PATCH 标 manual ─────────────────────────────────

async def test_post_marks_manual(session_maker):
    from api.v1.store_memory import add_memory, MemoryCreate
    sid = uuid.uuid4()
    store = type("S", (), {"id": sid})()
    async with session_maker() as db:
        item = await add_memory(MemoryCreate(content="老板亲定：禁止外带酒水"),
                                store=store, db=db)
    assert item.source == "manual"
    assert item.source_label == "店主定"


async def test_patch_marks_manual(session_maker):
    from api.v1.store_memory import update_memory, MemoryUpdate
    sid = uuid.uuid4()
    # 预置一条 AI 学的(auto)，老板手动改它 → 应转 manual
    async with session_maker() as db:
        m = StoreMemory(store_id=sid, type="semantic", content="AI原文",
                        confidence="medium", source="auto")
        db.add(m)
        await db.commit()
        mid = str(m.id)
    store = type("S", (), {"id": sid})()
    async with session_maker() as db:
        item = await update_memory(mid, MemoryUpdate(content="老板改后的正确说法"),
                                   store=store, db=db)
    assert item.source == "manual"
    assert item.source_label == "店主定"
    # 落库确认
    async with session_maker() as db:
        r = await db.get(StoreMemory, uuid.UUID(mid))
        assert r.source == "manual" and r.content == "老板改后的正确说法"
