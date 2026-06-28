"""阶段1 media_jobs runner:后台跑 work_fn、边跑边写进度、完成/失败落库。

把 runner 的 async_session 换成 in-memory(同一 engine 多 session 共享内存库)来验真实流程。
"""
import asyncio
import uuid

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from db.base import Base
from models.store import Store
from models.user import User
from services import media_jobs_service as mj
from services import media_jobs_runner as runner


async def _seed(db, sid):
    u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    db.add(Store(id=sid, owner_id=u.id, name="店"))
    await db.flush()


def test_runner_run_completes(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "generate")
            jid = str(job.id)

        seen = []

        async def work_fn(progress):
            await progress(30, "正在出图…")
            seen.append("ran")
            return {"urls": ["/uploads/a.png"]}

        await runner._run(jid, sid, work_fn)

        async with Session() as db:
            got = await mj.get_job(db, jid, sid)
            assert seen == ["ran"]
            assert got.status == "done" and got.progress == 100
            assert got.result == {"urls": ["/uploads/a.png"]}

    asyncio.run(main())


def test_runner_run_failure_marks_error(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "i2v")
            jid = str(job.id)

        async def work_fn(progress):
            raise RuntimeError("Ark 崩了")

        await runner._run(jid, sid, work_fn)

        async with Session() as db:
            got = await mj.get_job(db, jid, sid)
            assert got.status == "error" and "Ark 崩了" in (got.error or "")

    asyncio.run(main())


def test_runner_submit_returns_id_and_runs(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            await _seed(db, sid)

        async def work_fn(progress):
            await progress(50, "干活中")
            return {"ok": True}

        jid = await runner.submit(sid, "generate", work_fn)
        assert isinstance(jid, str) and jid

        got = None
        for _ in range(100):  # 让后台任务在同一 loop 上跑完
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done"
        assert got.result == {"ok": True}

    asyncio.run(main())
