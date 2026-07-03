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


# ────────────────────────────── F-10：on_done 完成回调 ──────────────────────────────
# generate_video/render_video 提交后立即返回，真正做完(成功/失败)靠这个钩子回灌通知/轨迹；
# 钩子对 studio.py/video_edit.py 现有调用点是可选的(不传=None=零行为变化，上面几个测试已覆盖)。

def test_runner_on_done_called_after_success(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "video")
            jid = str(job.id)

        async def work_fn(progress):
            return {"video_url": "/uploads/videos/a.mp4"}

        seen = {}

        async def on_done(job_id, status, result, error):
            seen["job_id"] = job_id
            seen["status"] = status
            seen["result"] = result
            seen["error"] = error

        await runner._run(jid, sid, work_fn, on_done=on_done)

        assert seen == {"job_id": jid, "status": "done",
                        "result": {"video_url": "/uploads/videos/a.mp4"}, "error": None}

    asyncio.run(main())


def test_runner_on_done_called_after_failure(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "video")
            jid = str(job.id)

        async def work_fn(progress):
            raise RuntimeError("Ark 超时")

        seen = {}

        async def on_done(job_id, status, result, error):
            seen["job_id"] = job_id
            seen["status"] = status
            seen["result"] = result
            seen["error"] = error

        await runner._run(jid, sid, work_fn, on_done=on_done)

        assert seen["status"] == "error"
        assert seen["result"] is None
        assert "Ark 超时" in seen["error"]

    asyncio.run(main())


def test_runner_on_done_exception_does_not_break_run(monkeypatch):
    """完成回调自己炸了也不能让 runner 崩、也不能盖掉已经落库的终态(job 仍标 done)。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            await _seed(db, sid)
            job = await mj.create_job(db, sid, "video")
            jid = str(job.id)

        async def work_fn(progress):
            return {"ok": True}

        async def bad_on_done(job_id, status, result, error):
            raise RuntimeError("通知层炸了")

        await runner._run(jid, sid, work_fn, on_done=bad_on_done)  # 不应向外抛

        async with Session() as db:
            got = await mj.get_job(db, jid, sid)
            assert got.status == "done"

    asyncio.run(main())


def test_runner_no_on_done_is_backward_compatible(monkeypatch):
    """不传 on_done(studio.py/video_edit.py 现状) → 行为跟改动前完全一样，不报错。"""
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

        async def work_fn(progress):
            return {"urls": ["/uploads/a.png"]}

        await runner._run(jid, sid, work_fn)  # 无 on_done

        async with Session() as db:
            got = await mj.get_job(db, jid, sid)
            assert got.status == "done"

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
