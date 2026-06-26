# -*- coding: utf-8 -*-
"""M12 #5：POST /stores 不得建第二家孤儿店。

单用户单店产品（首启 init_local 已 seed 一家店、get_current_store 永远取第一家）。
再 POST 只会建出一家永远取不到的孤儿店，须挡掉。
"""
import asyncio
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from db.base import Base
from models.user import User
from models.store import Store
from schemas.store import StoreCreate
from api.v1.stores import create_my_store


def test_first_store_ok_second_blocked():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        async with Session() as db:
            u = User(id=uuid.uuid4(), phone="1", password_hash="x", name="t")
            db.add(u)
            await db.commit()

            # 第一家：库里还没店 → 建成功
            s1 = await create_my_store(StoreCreate(name="第一家"), u, db)
            assert s1.name == "第一家"

            # 第二家：已有店 → 被挡，不真建出孤儿店
            with pytest.raises(HTTPException) as ei:
                await create_my_store(StoreCreate(name="第二家"), u, db)
            assert ei.value.status_code == 409
            assert "门店" in ei.value.detail

            # 库里仍只有一家店
            cnt = (await db.execute(select(func.count()).select_from(Store))).scalar_one()
            assert cnt == 1

    asyncio.run(main())
