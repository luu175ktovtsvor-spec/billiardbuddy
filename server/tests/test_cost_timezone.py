# -*- coding: utf-8 -*-
"""M12 #3：/cost 月度成本聚合的时区边界。

created_at 以 UTC 存；本月窗口起点须在业务时区（北京）取月初零点、再转 UTC 比较。
否则北京 6-01 00:00~08:00 的记录（UTC 还停在 5-31）会被按 UTC 墙钟错分到上月，
月初头 8 小时的花费整段算错月。
"""
import asyncio
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from db.base import Base
from models.user import User
from models.store import Store
from models.generation import Generation
from core.timezone import BUSINESS_TZ
import api.v1.quota as quota_api


def test_month_window_boundary_math():
    # 北京 2026-06-01 03:00 → 月份标签是 6 月；窗口起点 = 北京 6-01 00:00 = UTC 5-31 16:00
    local_now = datetime(2026, 6, 1, 3, 0, tzinfo=BUSINESS_TZ)
    start_utc, label = quota_api._month_window(local_now)
    assert label == "2026-06"
    assert start_utc == datetime(2026, 5, 31, 16, 0, tzinfo=timezone.utc)


def test_cost_counts_first_hours_of_month_correctly(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)

        # 固定"现在"为北京 2026-06-01 03:00（落在月初头 8 小时窗口内）
        fixed_now = datetime(2026, 6, 1, 3, 0, tzinfo=BUSINESS_TZ)
        monkeypatch.setattr(quota_api, "business_now", lambda: fixed_now)

        async with Session() as db:
            u = User(id=uuid.uuid4(), phone="1", password_hash="x", name="t")
            db.add(u)
            await db.flush()
            s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
            db.add(s)
            await db.flush()
            # gen_in：北京 6-01 03:00 = UTC 5-31 19:00 → 属于 6 月，必须计入
            db.add(Generation(
                id=uuid.uuid4(), store_id=s.id, type="agent",
                tokens_used=100, is_deleted=False,
                created_at=datetime(2026, 5, 31, 19, 0, tzinfo=timezone.utc),
            ))
            # gen_out：北京 5-31 18:00 = UTC 5-31 10:00 → 属于 5 月，不该计入
            db.add(Generation(
                id=uuid.uuid4(), store_id=s.id, type="agent",
                tokens_used=999, is_deleted=False,
                created_at=datetime(2026, 5, 31, 10, 0, tzinfo=timezone.utc),
            ))
            await db.commit()

            res = await quota_api.get_cost(store=s, db=db)
            assert res["month"] == "2026-06"
            assert res["total_count"] == 1      # 只有 gen_in 落在 6 月
            assert res["total_tokens"] == 100    # gen_out(999) 被正确排除

    asyncio.run(main())
