"""阶段1 media_jobs 服务:DB 状态机生命周期(create→progress→done / fail)+ 多店隔离 + 非法 kind。

media_jobs 不在 core/tenant 自动过滤范围(只覆盖 generations/usage_quotas)→ 隔离全靠服务里
显式 store_id 过滤,这里钉死它。
"""
import asyncio
import uuid

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册(含 MediaJob)
from db.base import Base
from models.store import Store
from models.user import User


async def _seed(db, *store_ids):
    u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    for sid in store_ids:
        db.add(Store(id=sid, owner_id=u.id, name="店"))
    await db.flush()


def test_media_job_lifecycle_create_progress_complete():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        from services import media_jobs_service as mj
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "generate", params={"prompt": "海报"})
            jid = job.id
            assert job.status == "queued" and job.progress == 0
            await mj.update_progress(db, jid, sid, progress=40, stage="正在出图…")
            await mj.complete_job(db, jid, sid, result={"urls": ["/uploads/a.png"]})

        async with Session() as db2:
            got = await mj.get_job(db2, jid, sid)
            assert got is not None
            assert got.status == "done" and got.progress == 100
            assert got.result == {"urls": ["/uploads/a.png"]}
            assert got.stage == "正在出图…"

    asyncio.run(main())


def test_media_job_fail_sets_error():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        from services import media_jobs_service as mj
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "i2v")
            await mj.fail_job(db, job.id, sid, "Ark 超时")
            got = await mj.get_job(db, job.id, sid)
            assert got.status == "error" and "Ark 超时" in (got.error or "")

    asyncio.run(main())


def test_media_job_store_scoped_and_list_active():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid, other = uuid.uuid4(), uuid.uuid4()
        from services import media_jobs_service as mj
        async with Session() as db:
            await _seed(db, sid, other)
            j1 = await mj.create_job(db, sid, "generate")
            j2 = await mj.create_job(db, sid, "edit")
            await mj.complete_job(db, j2.id, sid, result={})
            jo = await mj.create_job(db, other, "generate")

            assert await mj.get_job(db, j1.id, other) is None       # 别店取不到本店任务
            active = await mj.list_jobs(db, sid, active_only=True)   # 本店 active 只剩 j1(j2 已 done)
            assert {x.id for x in active} == {j1.id}
            assert {x.id for x in await mj.list_jobs(db, other)} == {jo.id}  # 别店列表只它自己的

    asyncio.run(main())


def test_media_job_invalid_kind_raises():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        from services import media_jobs_service as mj
        from core.exceptions import AIServiceError
        async with Session() as db:
            await _seed(db, sid)
            try:
                await mj.create_job(db, sid, "nonsense")
                assert False, "未知 kind 应抛错"
            except AIServiceError:
                pass

    asyncio.run(main())
