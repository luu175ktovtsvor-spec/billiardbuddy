"""阶段2 /studio 直连路由:H1 红线预检 + H3 张数护栏 + 异步出图(runner)+ 改图血缘回填。

generate_images 用 fake 顶掉(不真打生图 API);runner/studio 的 async_session 换 in-memory。
"""
import asyncio
import uuid
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from core.exceptions import AIServiceError
from core.tenant import set_tenant
from db.base import Base
from models.generation import Generation
from models.store import Store
from models.user import User
from services import media_jobs_service as mj
from services import media_jobs_runner as runner
import api.v1.studio as studio


async def _seed(db, sid):
    u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    db.add(Store(id=sid, owner_id=u.id, name="店"))
    await db.commit()  # 提交,后台 work_fn 的独立 session 才读得到 store
    return u.id


# ── 纯同步守卫:不需要 DB/runner ──

def test_clamp_count_h3():
    assert studio._clamp_count(10) == 4      # 超上限砍到 4
    assert studio._clamp_count(0) == 1       # 兜底至少 1
    assert studio._clamp_count(3) == 3
    assert studio._clamp_count("x") == 1     # 非法兜底


def test_studio_generate_blocks_redline():
    async def main():
        body = studio.StudioGenerateIn(prompt="性交易上门服务海报")
        try:
            await studio.studio_generate(body, user=SimpleNamespace(id=uuid.uuid4()),
                                         store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "红线内容应被拦"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_edit_requires_source_generation():
    async def main():
        body = studio.StudioEditIn(prompt="改亮一点", source_generation_id="")
        try:
            await studio.studio_edit(body, user=SimpleNamespace(id=uuid.uuid4()),
                                     store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "没指定要改的成品应报错"
        except AIServiceError:
            pass
    asyncio.run(main())


# ── 集成:runner + work_fn + session 接线 ──

def test_studio_generate_submits_job_and_completes(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            assert count == 4  # H3:count=9 被砍到 4
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="台球周赛海报", ratio="9:16", count=9)
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        assert jid

        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert got.result["urls"] == ["/uploads/a.png"]
    asyncio.run(main())


def test_studio_edit_backfills_parent_lineage(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
        parent_gid = uuid.uuid4()

        new_gid = uuid.uuid4()

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4",
                           refine_from=None, mask_path=None, count=1, **kw):
            assert refine_from == str(parent_gid)        # 源成品 id 当 refine_from 底图(不是 URL)
            assert mask_path == "/tmp/mask.png"          # mask 透传(局部重绘)
            db.add(Generation(id=new_gid, store_id=store.id, type="poster",
                              result="/uploads/edited.png", model_used="gpt-image-2"))
            await db.flush()
            return {"images": [{"generation_id": new_gid, "poster_url": "/uploads/edited.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioEditIn(prompt="把这块改成夜晚", source_generation_id=str(parent_gid),
                                   mask_path="/tmp/mask.png")
        out = await studio.studio_edit(body, user=SimpleNamespace(id=uid),
                                       store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]

        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)

        set_tenant(sid)
        async with Session() as db:
            g = await db.get(Generation, new_gid)
            assert g is not None and g.parent_generation_id == parent_gid  # 血缘已回填
        set_tenant(None)
    asyncio.run(main())
