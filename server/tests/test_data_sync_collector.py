import uuid

import pytest
from sqlalchemy import select, func

from models.sync_outbox import SyncOutbox
from services.data_sync.collector import collect_once


@pytest.mark.asyncio
async def test_collect_events_idempotent(db_session, seed_usage_event):
    await seed_usage_event(event="agent_chat", props={"latency_ms": 12})
    n1 = await collect_once(db_session)
    n2 = await collect_once(db_session)  # 再跑不应重复入队
    total = (await db_session.execute(select(func.count()).select_from(SyncOutbox))).scalar()
    assert n1 >= 1 and n2 == 0 and total == n1


@pytest.mark.asyncio
async def test_collect_generation_full_column_snapshot(db_session):
    """§0.3 全量不裁剪：gen 快照必须带上全部列（不只计划挑的那几个），
    含 input_params / parent_generation_id / title / updated_at 这些易被遗漏的字段。"""
    from models.generation import Generation

    sid = uuid.uuid4()
    g = Generation(
        store_id=sid, type="copywriting", sub_type="moments",
        prompt_used="写条朋友圈", result="今晚开台", model_used="mimo",
        tokens_used=42, input_params={"tone": "热闹"}, title="标题",
        effect_rating="good", is_favorite=True,
    )
    db_session.add(g)
    await db_session.commit()

    n = await collect_once(db_session)
    row = (await db_session.execute(
        select(SyncOutbox).where(SyncOutbox.kind == "gen")
    )).scalars().one()
    p = row.payload
    # 全列在案：计划挑过的 + 计划漏掉的
    for col in ("id", "store_id", "type", "sub_type", "prompt_used", "result",
                "model_used", "tokens_used", "effect_rating", "is_favorite",
                "input_params", "parent_generation_id", "title", "updated_at",
                "is_deleted", "created_at"):
        assert col in p, f"gen 快照漏了列 {col}（违反全量不裁剪）"
    assert p["input_params"] == {"tone": "热闹"} and p["title"] == "标题"
    assert n >= 1


@pytest.mark.asyncio
async def test_collect_skips_deleted_generation(db_session):
    """软删的生成记录不上行（查询带 is_deleted==False）。"""
    from models.generation import Generation

    db_session.add(Generation(store_id=uuid.uuid4(), type="poster", is_deleted=True))
    await db_session.commit()
    await collect_once(db_session)
    gens = (await db_session.execute(
        select(SyncOutbox).where(SyncOutbox.kind == "gen")
    )).scalars().all()
    assert gens == []
