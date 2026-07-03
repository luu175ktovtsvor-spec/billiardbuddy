# -*- coding: utf-8 -*-
"""F-10：generate_video 工具接 media_jobs 全链路集成测试。

不再是"审批通过后裸等最多 31 分钟"——handler 只提交后台任务立即返回任务号；真正的视频生成
在 media_jobs_runner 的后台 asyncio 任务里跑，跑完(成功/失败)由 media_job_notify 回灌
transcript + 弹通知，且 `_VIDEO_GENERATING` 并发锁要到这时候才释放。

用同一个 in-memory sqlite engine 做 runner/generate_video 两处的 async_session（同一进程内
多 session 共享内存库），照 test_studio_router.py 的既有集成测试范式；video_service.generate_video
本体用 fake 顶掉（不真打火山方舟 API、不烧钱）。
"""
import asyncio
import uuid
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from db.base import Base
from models.store import Store
from models.user import User
from services import media_jobs_service as mj
from services import media_jobs_runner as runner
from services.agent import tools as T
import services.agent.transcript as Tr


async def _seed(db, sid):
    u = User(id=uuid.uuid4(), phone="13800000001", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    db.add(Store(id=sid, owner_id=u.id, name="店"))
    await db.commit()  # 提交，后台 work_fn 的独立 session 才读得到 store
    return u.id


def _patch_key(monkeypatch):
    monkeypatch.setattr(
        "services.ai.factory.ProviderFactory.get_video_config_for_store",
        classmethod(lambda cls, store: ("ark-real-key", "https://ark.cn-beijing.volces.com/api/v3", "m")),
    )


async def _poll_done(sid, jid, tries=200):
    got = None
    for _ in range(tries):
        await asyncio.sleep(0.01)
        async with runner.async_session() as db:
            got = await mj.get_job(db, jid, sid)
        if got and got.status in ("done", "error"):
            break
    return got


def test_generate_video_job_completes_appends_transcript_and_notifies(monkeypatch, tmp_path):
    T._VIDEO_GENERATING.clear()  # 隔离：别被别的测试留下的锁键污染

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        # generate_video 的 work_fn 用 `from db.session import async_session` 现取(延迟导入避免
        # import 期重负载/循环依赖)，不是模块顶层绑定名——得连 db.session 源头一起换，
        # 只换 runner.async_session 管不到它。
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path))
        _patch_key(monkeypatch)

        notified = {}
        monkeypatch.setattr(
            "services.notify_service.push",
            lambda title, body, kind="info", **m: notified.update(title=title, kind=kind, meta=m),
        )

        async def fake_gen(**kw):
            assert kw["prompt"] == "开业宣传片"
            return {"video_url": "/uploads/videos/real.mp4", "generation_id": "g1", "conversation_id": "c1"}

        monkeypatch.setattr("services.video_service.generate_video", fake_gen)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        cid = "11111111-1111-1111-1111-111111111111"
        ctx = SimpleNamespace(
            store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid),
            db=None, allowed_paths=[], conversation_id=cid, _video_generated_this_run=False,
        )
        result = await T.generate_video({"description": "开业宣传片"}, ctx)
        assert "后台" in result
        lock_key = f"{uid}:{cid}"  # _gen_lock_key = (用户:会话)
        assert lock_key in T._VIDEO_GENERATING  # 提交完锁还没放（真正生成还没跑完）

        got = await _poll_done(sid, _extract_job_id(result))
        assert got is not None and got.status == "done", (got and got.status, got and got.error)
        assert got.result == {"video_url": "/uploads/videos/real.mp4"}

        # 锁必须在任务真正完成后才释放
        assert lock_key not in T._VIDEO_GENERATING

        # transcript 挂对了 conversation_id
        out = Tr.load_transcript(cid)
        assert out is not None and len(out) == 1
        assert "/uploads/videos/real.mp4" in out[0]["content"]

        # 弹了成功通知
        assert notified["kind"] == "media_job_done"

    asyncio.run(main())


def test_generate_video_job_failure_releases_lock_and_notifies_failure(monkeypatch, tmp_path):
    T._VIDEO_GENERATING.clear()  # 隔离：别被别的测试留下的锁键污染

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path))
        _patch_key(monkeypatch)

        notified = {}
        monkeypatch.setattr(
            "services.notify_service.push",
            lambda title, body, kind="info", **m: notified.update(kind=kind, body=body),
        )

        async def boom_gen(**kw):
            raise RuntimeError("火山方舟超时了")

        monkeypatch.setattr("services.video_service.generate_video", boom_gen)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        cid = "22222222-2222-2222-2222-222222222222"
        ctx = SimpleNamespace(
            store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid),
            db=None, allowed_paths=[], conversation_id=cid, _video_generated_this_run=False,
        )
        result = await T.generate_video({"description": "开业宣传片"}, ctx)
        lock_key = f"{uid}:{cid}"
        assert lock_key in T._VIDEO_GENERATING

        got = await _poll_done(sid, _extract_job_id(result))
        assert got is not None and got.status == "error"
        assert "火山方舟超时了" in (got.error or "")

        # 失败路径也必须释放锁——漏了=以后再也生不了视频
        assert lock_key not in T._VIDEO_GENERATING

        out = Tr.load_transcript(cid)
        assert out is not None and len(out) == 1
        assert "视频没做成" in out[0]["content"] and "火山方舟超时了" in out[0]["content"]
        assert notified["kind"] == "media_job_failed"

    asyncio.run(main())


def test_generate_video_job_completion_visible_via_get_agent_conversation(monkeypatch, tmp_path):
    """F-10 审查 Important 修复：老板『打开历史会话』唯一走的是 GET /agent/conversations/{id}
    (get_agent_conversation)，它只读 Generation 表、完全不读 transcript JSONL——不补一条
    Generation 完成行，这条 UI 路径永远只看得到提交时的占位文案。这里走真实
    `get_agent_conversation` 函数(不是直接读 transcript)断言完成消息真出现在历史查询里，
    且挂对了 conversation_id(另一个会话查不到)。"""
    T._VIDEO_GENERATING.clear()

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path))
        monkeypatch.setattr("services.notify_service.push", lambda *a, **k: None)
        _patch_key(monkeypatch)

        async def fake_gen(**kw):
            return {"video_url": "/uploads/videos/real3.mp4"}

        monkeypatch.setattr("services.video_service.generate_video", fake_gen)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        cid = "99999999-9999-9999-9999-999999999999"
        other_cid = "88888888-8888-8888-8888-888888888888"
        ctx = SimpleNamespace(
            store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid),
            db=None, allowed_paths=[], conversation_id=cid, _video_generated_this_run=False,
        )
        result = await T.generate_video({"description": "开业宣传片三"}, ctx)
        got = await _poll_done(sid, _extract_job_id(result))
        assert got is not None and got.status == "done", (got and got.status, got and got.error)

        from api.v1.agent import get_agent_conversation

        async with Session() as db:
            res = await get_agent_conversation(cid, user=None, store=SimpleNamespace(id=sid), db=db)
        assistant_texts = [m["content"] for m in res["messages"] if m["role"] == "assistant"]
        assert any("视频做好了" in t and "/uploads/videos/real3.mp4" in t for t in assistant_texts), assistant_texts

        # 挂对了 conversation_id：别的会话查不到这条完成消息
        async with Session() as db2:
            res_other = await get_agent_conversation(other_cid, user=None, store=SimpleNamespace(id=sid), db=db2)
        assert res_other["messages"] == []

    asyncio.run(main())


def test_generate_video_job_failure_visible_via_get_agent_conversation(monkeypatch, tmp_path):
    """失败路径同样要能被 get_agent_conversation 查到（"没做成、原因是什么"），不能只有成功
    路径才补 Generation 行。"""
    T._VIDEO_GENERATING.clear()

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path))
        monkeypatch.setattr("services.notify_service.push", lambda *a, **k: None)
        _patch_key(monkeypatch)

        async def boom_gen(**kw):
            raise RuntimeError("火山方舟又超时了")

        monkeypatch.setattr("services.video_service.generate_video", boom_gen)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        cid = "77777777-7777-7777-7777-777777777777"
        ctx = SimpleNamespace(
            store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid),
            db=None, allowed_paths=[], conversation_id=cid, _video_generated_this_run=False,
        )
        result = await T.generate_video({"description": "开业宣传片四"}, ctx)
        got = await _poll_done(sid, _extract_job_id(result))
        assert got is not None and got.status == "error"

        from api.v1.agent import get_agent_conversation

        async with Session() as db:
            res = await get_agent_conversation(cid, user=None, store=SimpleNamespace(id=sid), db=db)
        assistant_texts = [m["content"] for m in res["messages"] if m["role"] == "assistant"]
        assert any("视频没做成" in t and "火山方舟又超时了" in t for t in assistant_texts), assistant_texts

    asyncio.run(main())


def _extract_job_id(tool_result: str) -> str:
    import re
    m = re.search(r"任务号\s*([0-9a-fA-F-]{8,})", tool_result)
    assert m, f"没在工具返回文本里找到任务号:{tool_result}"
    return m.group(1)
