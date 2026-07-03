"""定时任务 REST API 测试：建/列/改/删 + 超10拒绝 + 跨店隔离。

跟 test_studio_router.py / test_media_jobs_service.py 同一约定：不用 TestClient，直接 import
端点模块、当普通异步函数调用（传 store=/db= 直接绕开 Depends），配 in-memory SQLite。

scheduled_tasks 表不在 core/tenant 自动过滤范围（只覆盖 generations/usage_quotas）——
隔离全靠服务里显式 store_id 过滤，这里钉死它（跨店拿不到、也改不了/删不了）。
"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
import api.v1.scheduled_tasks as api_sc
from db.base import Base
from models.scheduled_task import ScheduledTask
from models.store import Store
from models.user import User
from services.agent import scheduled_tasks as sc


async def _make_db():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    return eng, Session


async def _seed_store(db, sid=None) -> Store:
    u = User(id=uuid.uuid4(), phone=f"1390000{uuid.uuid4().hex[:4]}", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    store = Store(id=sid or uuid.uuid4(), owner_id=u.id, name="店")
    db.add(store)
    await db.flush()
    return store


class TestScheduledTasksApiCrud:
    def test_create_list_patch_delete_roundtrip(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)

                body = api_sc.ScheduledTaskCreate(
                    name="周报", instruction="出周报", schedule_kind="weekly",
                    schedule_spec={"weekday": 0, "hour": 9, "minute": 0},
                )
                created = await api_sc.create_scheduled_task_route(body, store=store, db=db)
                assert created.name == "周报"
                assert created.enabled is True
                assert created.next_run_at is not None

                lst = await api_sc.list_scheduled_tasks_route(store=store, db=db)
                assert len(lst) == 1 and lst[0].id == created.id

                updated = await api_sc.update_scheduled_task_route(
                    created.id, api_sc.ScheduledTaskUpdate(enabled=False), store=store, db=db,
                )
                assert updated.enabled is False

                # 改 schedule 也要重算 next_run_at
                old_next = updated.next_run_at
                updated2 = await api_sc.update_scheduled_task_route(
                    created.id,
                    api_sc.ScheduledTaskUpdate(schedule_kind="interval", schedule_spec={"minutes": 15}),
                    store=store, db=db,
                )
                assert updated2.schedule_kind == "interval"
                assert updated2.next_run_at != old_next

                deleted = await api_sc.delete_scheduled_task_route(created.id, store=store, db=db)
                assert deleted == {"status": "ok"}

                lst2 = await api_sc.list_scheduled_tasks_route(store=store, db=db)
                assert lst2 == []
            await eng.dispose()
        asyncio.run(main())

    def test_create_rejects_bad_kind(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                body = api_sc.ScheduledTaskCreate(name="x", instruction="y", schedule_kind="monthly", schedule_spec={})
                try:
                    await api_sc.create_scheduled_task_route(body, store=store, db=db)
                    assert False, "非法 schedule_kind 应该被拒绝"
                except HTTPException as e:
                    assert e.status_code == 400
            await eng.dispose()
        asyncio.run(main())

    def test_create_rejects_empty_name(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                body = api_sc.ScheduledTaskCreate(name="  ", instruction="y", schedule_kind="daily",
                                                    schedule_spec={"hour": 8, "minute": 0})
                try:
                    await api_sc.create_scheduled_task_route(body, store=store, db=db)
                    assert False
                except HTTPException as e:
                    assert e.status_code == 400
            await eng.dispose()
        asyncio.run(main())

    def test_over_limit_rejected(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                for i in range(sc._MAX_TASKS_PER_STORE):
                    db.add(ScheduledTask(
                        store_id=store.id, name=f"任务{i}", instruction="x", schedule_kind="daily",
                        schedule_spec={"hour": 8, "minute": 0},
                        next_run_at=datetime.now(timezone.utc) + timedelta(hours=1), enabled=True,
                    ))
                await db.commit()

                body = api_sc.ScheduledTaskCreate(name="超限", instruction="y", schedule_kind="daily",
                                                    schedule_spec={"hour": 8, "minute": 0})
                try:
                    await api_sc.create_scheduled_task_route(body, store=store, db=db)
                    assert False, "超过 10 条应该被拒绝"
                except HTTPException as e:
                    assert e.status_code == 400

                rows = (await db.execute(select(ScheduledTask))).scalars().all()
                assert len(rows) == sc._MAX_TASKS_PER_STORE
            await eng.dispose()
        asyncio.run(main())

    def test_reenable_after_fill_swap_rejected(self):
        """建满上限→停用1条→新建1条占回名额→把停用那条重新启用 应该被拒绝(400)，
        且启用中总数不能超过上限——堵住"停几条腾位置、新建顶上、再把旧的重新启用"绕过硬限的口子。
        """
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                for i in range(sc._MAX_TASKS_PER_STORE):
                    db.add(ScheduledTask(
                        store_id=store.id, name=f"任务{i}", instruction="x", schedule_kind="daily",
                        schedule_spec={"hour": 8, "minute": 0},
                        next_run_at=datetime.now(timezone.utc) + timedelta(hours=1), enabled=True,
                    ))
                await db.commit()
                rows = (await db.execute(select(ScheduledTask))).scalars().all()
                to_disable = rows[0]

                disabled = await api_sc.update_scheduled_task_route(
                    str(to_disable.id), api_sc.ScheduledTaskUpdate(enabled=False), store=store, db=db,
                )
                assert disabled.enabled is False

                # 新建一条顶上名额，启用中总数重新回到上限
                body = api_sc.ScheduledTaskCreate(name="顶替", instruction="y", schedule_kind="daily",
                                                    schedule_spec={"hour": 9, "minute": 0})
                created = await api_sc.create_scheduled_task_route(body, store=store, db=db)
                assert created.enabled is True

                # 再把之前停用的那条重新启用 —— 应该被挡住
                try:
                    await api_sc.update_scheduled_task_route(
                        str(to_disable.id), api_sc.ScheduledTaskUpdate(enabled=True), store=store, db=db,
                    )
                    assert False, "重新启用应该因超过上限被拒绝"
                except HTTPException as e:
                    assert e.status_code == 400

                all_rows = (await db.execute(select(ScheduledTask))).scalars().all()
                enabled_count = sum(1 for t in all_rows if t.store_id == store.id and t.enabled)
                assert enabled_count == sc._MAX_TASKS_PER_STORE
            await eng.dispose()
        asyncio.run(main())

    def test_delete_missing_returns_404(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                try:
                    await api_sc.delete_scheduled_task_route(str(uuid.uuid4()), store=store, db=db)
                    assert False
                except HTTPException as e:
                    assert e.status_code == 404
            await eng.dispose()
        asyncio.run(main())


class TestScheduledTasksApiCrossStoreIsolation:
    def test_store_b_cannot_see_or_touch_store_a_task(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store_a = await _seed_store(db)
                store_b = await _seed_store(db)

                body = api_sc.ScheduledTaskCreate(name="A店的任务", instruction="x", schedule_kind="daily",
                                                    schedule_spec={"hour": 8, "minute": 0})
                created = await api_sc.create_scheduled_task_route(body, store=store_a, db=db)

                # B 店 list 看不到 A 店的任务
                lst_b = await api_sc.list_scheduled_tasks_route(store=store_b, db=db)
                assert lst_b == []
                # A 店能看到自己的
                lst_a = await api_sc.list_scheduled_tasks_route(store=store_a, db=db)
                assert len(lst_a) == 1

                # B 店改/删 A 店任务 → 404（找不到，不是"改了别人的"）
                try:
                    await api_sc.update_scheduled_task_route(
                        created.id, api_sc.ScheduledTaskUpdate(enabled=False), store=store_b, db=db,
                    )
                    assert False, "B 店不该能改到 A 店的定时任务"
                except HTTPException as e:
                    assert e.status_code == 404

                try:
                    await api_sc.delete_scheduled_task_route(created.id, store=store_b, db=db)
                    assert False, "B 店不该能删掉 A 店的定时任务"
                except HTTPException as e:
                    assert e.status_code == 404

                # A 店任务安然无恙
                rows = (await db.execute(select(ScheduledTask))).scalars().all()
                assert len(rows) == 1 and rows[0].store_id == store_a.id
            await eng.dispose()
        asyncio.run(main())
