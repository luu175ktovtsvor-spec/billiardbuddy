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
    load_scoped_store_memory,
    memory_reference_labels,
    memory_matches_workdir,
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


def test_memory_reference_labels_match_injected_confirmed_memories():
    mems = [
        Memory("semantic", "我店在杭州，26 张台，主做竞技客户", source="manual"),
        Memory("semantic", "老板喜欢回答短一点", source="auto"),
    ]
    refs = memory_reference_labels(mems, intent="帮我写活动文案")
    assert refs == ["我店在杭州，26 张台，主做竞技客户", "老板喜欢回答短一点"]


def test_workdir_scoped_memory_matcher():
    # 项目记忆 marker 存完整路径，按完整路径隔离（不再按文件夹名，避免同名目录串记忆）
    scoped = "【工作目录:/Users/me/六月报表】这个项目按老板版口径输出"
    assert memory_matches_workdir(scoped, "/Users/me/六月报表")          # 完整路径匹配
    assert not memory_matches_workdir(scoped, "/Users/other/六月报表")    # 同名不同路径 → 隔离不串（修复点）
    assert not memory_matches_workdir(scoped, "六月报表")                 # 裸文件夹名不再匹配完整路径 marker
    assert not memory_matches_workdir(scoped, "/tmp/七月报表")
    assert not memory_matches_workdir(scoped, None)
    assert memory_matches_workdir("全局资料", None)


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

    # AI 学到一条新事实（高置信，走 auto 即时路径——本测试测的是"manual 不受牵连"，
    # 不是置信度分流，故意用 high 避开 F7②的 pending 分流，让下面照旧走 consolidate/auto）
    # 且 consolidate 故意想把所有都"整合"掉（模拟 AI 想覆盖）
    async def fake_extract(text, store=None):
        return [Memory("semantic", "新学到-台费60", "high", source="auto")]

    async def fake_consolidate(existing, new, store=None):
        # 即便 AI 返回的整合结果里完全不含 manual 内容，manual 也不能被删
        return [Memory("semantic", "新学到-台费60", "high", source="auto")]

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


async def test_deleted_store_memory_not_loaded_or_listed(session_maker):
    sid = uuid.uuid4()
    async with session_maker() as db:
        db.add(StoreMemory(store_id=sid, type="semantic", content="正常记忆",
                           confidence="high", source="manual"))
        db.add(StoreMemory(store_id=sid, type="semantic", content="已删记忆",
                           confidence="high", source="manual", is_deleted=True))
        await db.commit()

        mems = await ms.load_store_memory(db, sid)
        assert [m.content for m in mems] == ["正常记忆"]

        from api.v1.store_memory import list_memories
        store = type("S", (), {"id": sid})()
        items = await list_memories(store=store, db=db)
        assert [m.content for m in items] == ["正常记忆"]


async def test_pending_memory_listed_but_not_injected(session_maker):
    sid = uuid.uuid4()
    async with session_maker() as db:
        db.add(StoreMemory(store_id=sid, type="semantic", content="待确认：可能主做竞技客户",
                           confidence="low", source="pending"))
        await db.commit()

        assert await ms.load_store_memory(db, sid) == []

        from api.v1.store_memory import list_memories
        items = await list_memories(store=type("S", (), {"id": sid})(), db=db)
        assert len(items) == 1
        assert items[0].source == "pending"
        assert items[0].source_label == "待确认"


async def test_workdir_scoped_memory_only_loaded_for_matching_workdir(session_maker):
    sid = uuid.uuid4()
    async with session_maker() as db:
        db.add(StoreMemory(store_id=sid, type="semantic", content="全局门店资料",
                           confidence="high", source="manual"))
        db.add(StoreMemory(store_id=sid, type="preference", content="【工作目录:/Users/me/六月报表】本项目用老板版摘要",
                           confidence="high", source="manual"))
        db.add(StoreMemory(store_id=sid, type="preference", content="【工作目录:/Users/me/七月报表】本项目用财务版摘要",
                           confidence="high", source="manual"))
        await db.commit()

        no_wd = await load_scoped_store_memory(db, sid)
        assert [m.content for m in no_wd] == ["全局门店资料"]

        june = await load_scoped_store_memory(db, sid, "/Users/me/六月报表")
        assert [m.content for m in june] == ["全局门店资料", "本项目用老板版摘要"]

        july = await load_scoped_store_memory(db, sid, "/Users/me/七月报表")
        assert [m.content for m in july] == ["全局门店资料", "本项目用财务版摘要"]

        # 同名不同路径不串（完整路径隔离修复点）
        other = await load_scoped_store_memory(db, sid, "/Users/other/六月报表")
        assert [m.content for m in other] == ["全局门店资料"]


async def test_add_pending_memory_candidate_is_deduped_and_not_injected(session_maker):
    sid = uuid.uuid4()
    async with session_maker() as db:
        first = await ms.add_pending_memory_candidate(db, sid, "从报表提取：团购占比偏高", "operational")
        second = await ms.add_pending_memory_candidate(db, sid, "从报表提取：团购占比偏高", "operational")
        assert first.id == second.id
        rows = (await db.execute(select(StoreMemory).where(StoreMemory.store_id == sid))).scalars().all()
        assert len(rows) == 1
        assert rows[0].source == "pending"
        assert await ms.load_store_memory(db, sid) == []


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


async def test_candidate_confirm_becomes_manual(session_maker):
    from api.v1.store_memory import add_memory_candidate, confirm_memory, MemoryCandidateCreate
    sid = uuid.uuid4()
    store = type("S", (), {"id": sid})()
    async with session_maker() as db:
        item = await add_memory_candidate(MemoryCandidateCreate(content="看起来主做竞技客群"),
                                          store=store, db=db)
        assert item.source == "pending"
        confirmed = await confirm_memory(item.id, store=store, db=db)
        assert confirmed.source == "manual"
        assert confirmed.confidence == "high"


async def test_workdir_scope_hidden_in_memory_api_item(session_maker):
    from api.v1.store_memory import add_memory, list_memories, MemoryCreate
    sid = uuid.uuid4()
    store = type("S", (), {"id": sid})()
    async with session_maker() as db:
        item = await add_memory(MemoryCreate(content="这个项目用老板版摘要", working_dir="/tmp/六月报表"),
                                store=store, db=db)
        assert item.content == "这个项目用老板版摘要"
        assert item.scope == "working_dir"
        assert item.scope_label == "工作目录：六月报表"

        listed = await list_memories(store=store, db=db)
        assert listed[0].content == "这个项目用老板版摘要"
        assert listed[0].scope_label == "工作目录：六月报表"


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


async def test_patch_preserves_workdir_scope(session_maker):
    from api.v1.store_memory import add_memory, update_memory, MemoryCreate, MemoryUpdate
    sid = uuid.uuid4()
    store = type("S", (), {"id": sid})()
    async with session_maker() as db:
        item = await add_memory(MemoryCreate(content="这个项目用老板版摘要", working_dir="/tmp/六月报表"),
                                store=store, db=db)
        updated = await update_memory(item.id, MemoryUpdate(content="这个项目用店长版摘要"),
                                      store=store, db=db)
        assert updated.content == "这个项目用店长版摘要"
        assert updated.scope == "working_dir"
        assert updated.scope_label == "工作目录：六月报表"

        no_wd = await load_scoped_store_memory(db, sid)
        assert [m.content for m in no_wd] == []

        # 用与创建时相同的完整路径召回（marker 现存完整路径，按整路径隔离）
        june = await load_scoped_store_memory(db, sid, "/tmp/六月报表")
        assert [m.content for m in june] == ["这个项目用店长版摘要"]


async def test_delete_store_memory_soft_deletes(session_maker):
    from api.v1.store_memory import delete_memory
    sid = uuid.uuid4()
    async with session_maker() as db:
        m = StoreMemory(store_id=sid, type="semantic", content="误删的资料",
                        confidence="medium", source="manual")
        db.add(m)
        await db.commit()
        mid = str(m.id)

        res = await delete_memory(mid, store=type("S", (), {"id": sid})(), db=db)
        assert res["status"] == "ok"

    async with session_maker() as db:
        r = await db.get(StoreMemory, uuid.UUID(mid))
        assert r.is_deleted is True
        assert r.deleted_at is not None
