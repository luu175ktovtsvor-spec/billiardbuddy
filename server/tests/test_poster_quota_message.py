# -*- coding: utf-8 -*-
"""M12 #4：海报额度报错文案不得自相矛盾。

原文案同时说"已达上限"又说"桌面本地不限额"——两句打架。桌面版（DESKTOP_LOCAL=1）
本就在前面短路返回、不会抛此错；真会抛的只有非桌面回退路径，那条路径额度是真的，
文案就该统一成不矛盾的一句。
"""
import asyncio
import uuid

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from db.base import Base
from models.user import User
from models.store import Store
from models.quota import UsageQuota
from core.exceptions import QuotaExceededError
from services.quota_service import check_poster_quota, _period_start_now


def test_poster_quota_message_not_contradictory(monkeypatch):
    monkeypatch.delenv("DESKTOP_LOCAL", raising=False)  # 走非桌面回退路径才会抛

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        async with Session() as db:
            u = User(id=uuid.uuid4(), phone="1", password_hash="x", name="t")
            db.add(u)
            await db.flush()
            s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
            db.add(s)
            await db.flush()
            # 预置一条本月用满的海报额度（current_period_start 设为本月，避免被跨月重置清零）
            db.add(UsageQuota(
                id=uuid.uuid4(), store_id=s.id,
                monthly_generation_limit=30, monthly_tokens_limit=240000,
                monthly_generations_used=0, monthly_tokens_used=0,
                monthly_poster_limit=3, monthly_posters_used=3,
                current_period_start=_period_start_now(),
            ))
            await db.commit()

            with pytest.raises(QuotaExceededError) as ei:
                await check_poster_quota(db, str(s.id))
            msg = ei.value.message
            assert "上限" in msg          # 仍说明已达上限
            assert "不限额" not in msg     # 但不能再自相矛盾地说"不限额"

    asyncio.run(main())
